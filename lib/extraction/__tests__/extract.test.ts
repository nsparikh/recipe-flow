import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { RecipeGraphSchema, type RecipeGraph } from "../../schema/recipe-graph";
import { extractRecipeGraph, MODEL, EFFORT } from "../extract";
import { buildRepairUserMessage, EXTRACTION_SYSTEM_PROMPT } from "../prompt";

const raw = JSON.parse(readFileSync("fixtures/minestrone.graph.json", "utf8"));
function validGraph(): RecipeGraph {
  return RecipeGraphSchema.parse(JSON.parse(JSON.stringify(raw)));
}
function brokenGraph(): RecipeGraph {
  const g = validGraph();
  g.edges.push({ from: "ing_does_not_exist", to: "s1", type: "ingredient" });
  return g;
}

interface FakeResponse {
  parsed_output?: unknown;
  text?: string;
}

/** Stands in for the SDK so the repair loop can be exercised without spending API calls. */
function fakeClient(responses: FakeResponse[]) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        calls.push(params);
        const response = responses[calls.length - 1];
        if (!response) throw new Error(`Unexpected call ${calls.length} — only ${responses.length} stubbed.`);
        return {
          finalMessage: async () => ({
            parsed_output: response.parsed_output,
            content: response.text ? [{ type: "text", text: response.text }] : [],
            usage: {
              input_tokens: 100,
              output_tokens: 200,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 10,
            },
          }),
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("happy path", () => {
  it("returns the graph on the first attempt when it validates", async () => {
    const { client, calls } = fakeClient([{ parsed_output: validGraph() }]);
    const outcome = await extractRecipeGraph("some recipe", { client });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.graph.title).toBe("Classic Minestrone Soup");
    expect(calls).toHaveLength(1);
  });

  it("surfaces validation warnings without failing", async () => {
    const g = validGraph();
    g.edges = g.edges.filter((e) => e.from !== "ing_lemon");
    const { client } = fakeClient([{ parsed_output: g }]);
    const outcome = await extractRecipeGraph("some recipe", { client });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.warnings.join(" ")).toContain("lemon juice");
  });

  it("falls back to parsing the raw text when parsed_output is absent", async () => {
    const { client } = fakeClient([{ text: JSON.stringify(validGraph()) }]);
    const outcome = await extractRecipeGraph("some recipe", { client });
    expect(outcome.ok).toBe(true);
  });
});

describe("repair loop", () => {
  it("feeds validation errors back and accepts the corrected graph", async () => {
    const { client, calls } = fakeClient([
      { parsed_output: brokenGraph() },
      { parsed_output: validGraph() },
    ]);
    const outcome = await extractRecipeGraph("some recipe", { client });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempts).toBe(2);

    // The second call continues the same conversation rather than starting fresh.
    const secondMessages = calls[1].messages as Anthropic.MessageParam[];
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[1].role).toBe("assistant");
    expect(secondMessages[2].role).toBe("user");
    expect(String(secondMessages[2].content)).toContain("UNKNOWN_EDGE_ENDPOINT");
  });

  it("gives up after the configured number of repairs", async () => {
    const { client, calls } = fakeClient([
      { parsed_output: brokenGraph() },
      { parsed_output: brokenGraph() },
      { parsed_output: brokenGraph() },
    ]);
    const outcome = await extractRecipeGraph("some recipe", { client, maxRepairAttempts: 2 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // One initial attempt plus two repairs.
    expect(calls).toHaveLength(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.errors.map((e) => e.code)).toContain("UNKNOWN_EDGE_ENDPOINT");
    // The failed graph comes back for debugging rather than being discarded.
    expect(outcome.partialGraph?.title).toBe("Classic Minestrone Soup");
  });

  it("honours a repair budget of zero", async () => {
    const { client, calls } = fakeClient([{ parsed_output: brokenGraph() }]);
    const outcome = await extractRecipeGraph("some recipe", { client, maxRepairAttempts: 0 });

    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("accumulates token usage across every attempt", async () => {
    const { client } = fakeClient([{ parsed_output: brokenGraph() }, { parsed_output: validGraph() }]);
    const outcome = await extractRecipeGraph("some recipe", { client });

    expect(outcome.usage.inputTokens).toBe(200);
    expect(outcome.usage.outputTokens).toBe(400);
    expect(outcome.usage.cacheReadTokens).toBe(100);
  });
});

describe("unusable responses", () => {
  it("reports a clear failure when nothing parseable comes back", async () => {
    const { client } = fakeClient([{ text: "I could not find a recipe in that text." }]);
    const outcome = await extractRecipeGraph("not a recipe", { client });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/did not return a graph/i);
  });

  it("reports a failure on an entirely empty response", async () => {
    const { client } = fakeClient([{}]);
    const outcome = await extractRecipeGraph("", { client });
    expect(outcome.ok).toBe(false);
  });
});

describe("request shape", () => {
  it("sends the configured model and effort with adaptive thinking", async () => {
    const { client, calls } = fakeClient([{ parsed_output: validGraph() }]);
    await extractRecipeGraph("some recipe", { client });

    expect(calls[0].model).toBe(MODEL);
    expect(calls[0].thinking).toEqual({ type: "adaptive" });
    expect((calls[0].output_config as Record<string, unknown>).effort).toBe(EFFORT);
    expect((calls[0].output_config as Record<string, unknown>).format).toBeDefined();
  });

  it("puts a cache breakpoint on the static system prompt", async () => {
    const { client, calls } = fakeClient([{ parsed_output: validGraph() }]);
    await extractRecipeGraph("some recipe", { client });

    const system = calls[0].system as Array<Record<string, unknown>>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it("wraps the recipe so it cannot be confused with instructions", async () => {
    const { client, calls } = fakeClient([{ parsed_output: validGraph() }]);
    await extractRecipeGraph("Chop an onion.", { client });

    const messages = calls[0].messages as Anthropic.MessageParam[];
    expect(String(messages[0].content)).toContain("<recipe>");
    expect(String(messages[0].content)).toContain("Chop an onion.");
  });
});

describe("repair message", () => {
  it("lists each error with its code", () => {
    const message = buildRepairUserMessage([
      { code: "CYCLE", message: "The graph contains a cycle: s1 -> s2 -> s1." },
      { code: "ORPHAN_STEP", message: 'Step "s9" has no edges at all.', nodeId: "s9" },
    ]);
    expect(message).toContain("[CYCLE]");
    expect(message).toContain("[ORPHAN_STEP]");
    expect(message).toContain("s1 -> s2 -> s1");
  });
});

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RecipeGraphSchema, type RecipeGraph } from "../schema/recipe-graph";
import { validateRecipeGraph, type ValidationError } from "../graph/validate";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  buildRepairUserMessage,
} from "./prompt";

/**
 * Prose -> RecipeGraph, with a bounded repair loop.
 *
 * Streams rather than using `messages.create`, for two reasons: the graph for a full recipe is a
 * large output, and streaming holds the HTTP connection open past the serverless function's
 * inactivity timeout. `zodOutputFormat` still gives a validated `parsed_output` at the end.
 */

/**
 * Model and effort are deliberately kept together here as the single place to tune cost.
 *
 * Sonnet 5 at medium effort is the current setting — extraction is a well-specified structured
 * task, so the cheapest configuration that does it well is the right default while the prompt is
 * still settling. `claude-opus-5` with `effort: "high"` is the quality ceiling if extraction starts
 * missing dependencies; `effort: "low"` is the floor if cost matters more than nuance.
 *
 * Eventually worth exposing to users alongside their API key, since they pay for it.
 */
export const MODEL = "claude-sonnet-5";
export const EFFORT = "medium" as const;

export const MAX_REPAIR_ATTEMPTS = 2;
const MAX_TOKENS = 32000;

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type ExtractionOutcome =
  | {
      ok: true;
      graph: RecipeGraph;
      /** Warnings from the model and from validation, merged. */
      warnings: string[];
      /** 1 means it validated first time; higher means the repair loop ran. */
      attempts: number;
      usage: ExtractionUsage;
    }
  | {
      ok: false;
      message: string;
      errors: ValidationError[];
      attempts: number;
      /** The last graph produced, even though it failed validation. Useful for debugging. */
      partialGraph?: RecipeGraph;
      usage: ExtractionUsage;
    };

export interface ExtractOptions {
  /** The end user's Anthropic key. Used for this request only — never stored or logged. */
  apiKey?: string;
  /** Injectable for tests, so the repair loop can be exercised without API calls. */
  client?: Anthropic;
  maxRepairAttempts?: number;
  signal?: AbortSignal;
}

export async function extractRecipeGraph(
  recipeText: string,
  options: ExtractOptions = {},
): Promise<ExtractionOutcome> {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const maxRepairAttempts = options.maxRepairAttempts ?? MAX_REPAIR_ATTEMPTS;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildExtractionUserMessage(recipeText) },
  ];

  const usage: ExtractionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  let lastGraph: RecipeGraph | undefined;
  let lastErrors: ValidationError[] = [];

  // One initial attempt, then up to `maxRepairAttempts` corrections.
  for (let attempt = 1; attempt <= maxRepairAttempts + 1; attempt++) {
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: {
          effort: EFFORT,
          format: zodOutputFormat(RecipeGraphSchema),
        },
        system: [
          {
            type: "text",
            text: EXTRACTION_SYSTEM_PROMPT,
            // Static and large: repair turns and later extractions read it from cache.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
      },
      { signal: options.signal },
    );

    const message = await stream.finalMessage();
    accumulateUsage(usage, message.usage);

    const graph = readGraph(message);
    if (!graph) {
      return {
        ok: false,
        message:
          "The model did not return a graph matching the schema. This usually means the input was not a recipe.",
        errors: [],
        attempts: attempt,
        partialGraph: lastGraph,
        usage,
      };
    }

    lastGraph = graph;
    const validation = validateRecipeGraph(graph);

    if (validation.ok) {
      return {
        ok: true,
        graph,
        warnings: validation.warnings,
        attempts: attempt,
        usage,
      };
    }

    lastErrors = validation.errors;

    // Continue the conversation so the repair turn keeps the cached prefix and sees its own output.
    messages.push(
      { role: "assistant", content: JSON.stringify(graph) },
      { role: "user", content: buildRepairUserMessage(validation.errors) },
    );
  }

  return {
    ok: false,
    message: `The graph still failed validation after ${maxRepairAttempts} repair attempts.`,
    errors: lastErrors,
    attempts: maxRepairAttempts + 1,
    partialGraph: lastGraph,
    usage,
  };
}

/**
 * `parsed_output` is populated by the SDK when the response matches the schema. It can be null on
 * a refusal or a malformed response, so fall back to parsing the text before giving up.
 */
function readGraph(message: Anthropic.Message & { parsed_output?: unknown }): RecipeGraph | null {
  if (message.parsed_output) {
    const parsed = RecipeGraphSchema.safeParse(message.parsed_output);
    if (parsed.success) return parsed.data;
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) return null;

  try {
    const parsed = RecipeGraphSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function accumulateUsage(total: ExtractionUsage, usage: Anthropic.Usage): void {
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
}

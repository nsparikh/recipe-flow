import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RecipeGraphSchema, type RecipeGraph, type StepNode } from "../../schema/recipe-graph";
import { deriveTopology } from "../../graph/topology";
import { renderMermaid, formatTime, escapeLabel } from "../mermaid";

function load(name: string): RecipeGraph {
  return RecipeGraphSchema.parse(JSON.parse(readFileSync(`fixtures/${name}.graph.json`, "utf8")));
}
const minestrone = () => renderMermaid(deriveTopology(load("minestrone")));
const pasta = () => renderMermaid(deriveTopology(load("garlic-butter-pasta")));

describe("structure", () => {
  it("opens with a left-to-right flowchart", () => {
    expect(minestrone().split("\n")[0]).toBe("flowchart LR");
  });

  it("declares every node exactly once", () => {
    const out = minestrone();
    const g = load("minestrone");
    for (const node of [...g.ingredients, ...g.steps]) {
      const declarations = out.split("\n").filter((l) => l.trim().startsWith(`${node.id}[`) || l.trim().startsWith(`${node.id}(`));
      expect(declarations, `node ${node.id}`).toHaveLength(1);
    }
  });

  it("renders every edge", () => {
    const out = minestrone();
    const arrows = out.split("\n").filter((l) => l.includes("-->"));
    expect(arrows).toHaveLength(load("minestrone").edges.length);
  });

  it("uses stadium shapes for ingredients and rectangles for steps", () => {
    const out = minestrone();
    expect(out).toContain('ing_onion(["yellow onion<br/>1 medium"])');
    expect(out).toMatch(/p1\["Chop onion<br\/>~3m"\]/);
  });

  it("labels edges with the portion or the intermediate product", () => {
    const out = minestrone();
    expect(out).toContain('ing_oil -->|"3 tablespoons"| s1');
    expect(out).toContain('s2 -->|"softened soffritto"| s3');
    // Pure ordering carries no label.
    expect(out).toContain("s4 --> s5");
  });
});

describe("estimate marking", () => {
  const step = (over: Partial<StepNode>): StepNode => ({
    id: "x", type: "cook", label: "x", optional: false, inferred: false,
    activeTimeEstimated: false, passiveTimeEstimated: false, ...over,
  });

  it("marks estimated times with a tilde and leaves stated times bare", () => {
    expect(formatTime(step({ activeTimeMin: 8 }))).toBe("8m");
    expect(formatTime(step({ activeTimeMin: 3, activeTimeEstimated: true }))).toBe("~3m");
  });

  it("labels passive time as a wait", () => {
    expect(formatTime(step({ activeTimeMin: 0, passiveTimeMin: 15 }))).toBe("15m wait");
    expect(formatTime(step({ activeTimeMin: 1, activeTimeEstimated: true, passiveTimeMin: 6, passiveTimeEstimated: true })))
      .toBe("~1m + ~6m wait");
  });

  it("omits zero active time rather than printing 0m", () => {
    // A covered simmer should read "15m wait", not "0m + 15m wait".
    expect(formatTime(step({ activeTimeMin: 0, passiveTimeMin: 15 }))).toBe("15m wait");
    expect(minestrone()).toMatch(/s6\["Simmer covered<br\/>15m wait"\]/);
  });

  it("has no time segment at all when the step has no timing", () => {
    expect(formatTime(step({}))).toBe("");
  });
});

describe("styling", () => {
  it("classes ingredients, passive steps and the terminal step", () => {
    const out = minestrone();
    expect(out).toMatch(/^ {2}class .*ing_onion.* ingredient$/m);
    expect(out).toMatch(/^ {2}class s5,s6,s8 passive$/m);
    expect(out).toMatch(/^ {2}class s10 terminal$/m);
  });

  it("marks the critical path", () => {
    expect(minestrone()).toMatch(/^ {2}class p2,s2,s3,s4,s5,s6,s7,s8,s9,s10 critical$/m);
  });

  it("distinguishes inferred from optional with different properties", () => {
    const out = minestrone();
    expect(out).toContain("classDef optional stroke-dasharray:4 4");
    expect(out).toContain("classDef inferred opacity:0.72");
    // p8 is both optional and inferred, so both classes must apply to it.
    expect(out).toMatch(/^ {2}class .*\bp8\b.* optional$/m);
    expect(out).toMatch(/^ {2}class .*\bp8\b.* inferred$/m);
  });
});

describe("components", () => {
  it("wraps a sub-recipe in a subgraph", () => {
    const out = pasta();
    expect(out).toContain('subgraph cmp_sauce["Sauce"]');
    expect(out).toMatch(/^ {2}end$/m);
  });

  it("declares component members inside the subgraph and others outside", () => {
    const lines = pasta().split("\n");
    const start = lines.findIndex((l) => l.includes("subgraph cmp_sauce"));
    const end = lines.findIndex((l, i) => i > start && l.trim() === "end");
    const inside = lines.slice(start, end).join("\n");
    expect(inside).toContain("s2[");
    expect(inside).toContain("ing_butter([");
    expect(inside).not.toContain("s4[");
  });

  it("crosses component boundaries with ordinary edges", () => {
    // The whole reason for the flat representation: sauce -> assembly needs no special handling.
    expect(pasta()).toContain('s3 -->|"sauce"| s4');
  });

  it("emits no subgraph for a recipe without components", () => {
    expect(minestrone()).not.toContain("subgraph");
  });
});

describe("escaping", () => {
  it("encodes characters that would break Mermaid", () => {
    expect(escapeLabel('a "quoted" word')).toBe("a #quot;quoted#quot; word");
    expect(escapeLabel("3 < 4 > 2")).toBe("3 #lt; 4 #gt; 2");
    // `#` must be encoded first or it would corrupt the other entity codes.
    expect(escapeLabel("#1 rated")).toBe("#35;1 rated");
  });

  it("survives a label containing quotes end to end", () => {
    const g = load("minestrone");
    g.steps[0].label = 'Chop the "big" onion';
    const out = renderMermaid(deriveTopology(g));
    expect(out).toContain("#quot;big#quot;");
    expect(out).not.toMatch(/p1\["Chop the "big/);
  });
});

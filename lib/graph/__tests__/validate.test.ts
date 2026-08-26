import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RecipeGraphSchema, type RecipeGraph } from "../../schema/recipe-graph";
import { validateRecipeGraph } from "../validate";

const raw = JSON.parse(readFileSync("fixtures/minestrone.graph.json", "utf8"));

/** Structured clone so mutation tests can't leak into each other. */
function fixture(): RecipeGraph {
  return RecipeGraphSchema.parse(JSON.parse(JSON.stringify(raw)));
}

describe("minestrone golden fixture", () => {
  it("parses against the schema", () => {
    expect(() => RecipeGraphSchema.parse(raw)).not.toThrow();
  });

  it("validates with no errors and no warnings", () => {
    const result = validateRecipeGraph(fixture());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("matches the reference diagram's shape", () => {
    const g = fixture();
    expect(g.ingredients).toHaveLength(21);
    expect(g.steps).toHaveLength(18);
    expect(g.edges).toHaveLength(42);
    expect(g.terminalStepIds).toEqual(["s10"]);
  });

  it("marks every prep step inferred, and no instruction step inferred", () => {
    const g = fixture();
    const prep = g.steps.filter((s) => s.type === "prep");
    expect(prep).toHaveLength(8);
    expect(prep.every((s) => s.inferred)).toBe(true);
    expect(g.steps.filter((s) => s.id.startsWith("s")).every((s) => !s.inferred)).toBe(true);
  });

  it("marks only recipe-stated times as non-estimated", () => {
    const g = fixture();
    const statedActive = g.steps.filter((s) => s.activeTimeMin !== undefined && !s.activeTimeEstimated);
    const statedPassive = g.steps.filter((s) => s.passiveTimeMin !== undefined && !s.passiveTimeEstimated);
    // "about 8 minutes" and "about 2 minutes"
    expect(statedActive.map((s) => s.id).sort()).toEqual(["s2", "s3"]);
    // "Simmer for 15 minutes" and "about 20 minutes"
    expect(statedPassive.map((s) => s.id).sort()).toEqual(["s6", "s8"]);
  });

  it("splits the divided olive oil across two steps", () => {
    const g = fixture();
    const oilEdges = g.edges.filter((e) => e.from === "ing_oil");
    expect(oilEdges).toHaveLength(2);
    expect(oilEdges.map((e) => e.quantity)).toEqual(["3 tablespoons", "1 tablespoon"]);
    // The ingredient node carries the total; the edges carry the portions.
    expect(g.ingredients.find((i) => i.id === "ing_oil")?.amount).toBe(4);
  });
});

describe("validation errors", () => {
  it("catches a dangling edge endpoint", () => {
    const g = fixture();
    g.edges.push({ from: "ing_nonexistent", to: "s1", type: "ingredient" });
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("UNKNOWN_EDGE_ENDPOINT");
  });

  it("catches an edge pointing into an ingredient", () => {
    const g = fixture();
    g.edges.push({ from: "s1", to: "ing_salt", type: "sequence" });
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("EDGE_INTO_INGREDIENT");
  });

  it("catches a cycle and reports the path", () => {
    const g = fixture();
    g.edges.push({ from: "s8", to: "s5", type: "sequence" });
    const cycleError = validateRecipeGraph(g).errors.find((e) => e.code === "CYCLE");
    expect(cycleError).toBeDefined();
    expect(cycleError!.message).toContain("s5");
  });

  it("catches a duplicate node id", () => {
    const g = fixture();
    g.steps.push({ ...g.steps[0] });
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("DUPLICATE_NODE_ID");
  });

  it("catches a duplicate edge", () => {
    const g = fixture();
    g.edges.push({ from: "s9", to: "s10", type: "sequence" });
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("DUPLICATE_EDGE");
  });

  it("catches a terminal step that still has outgoing edges", () => {
    const g = fixture();
    g.terminalStepIds = ["s9"];
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("TERMINAL_HAS_OUTGOING");
  });

  it("catches an orphaned step", () => {
    const g = fixture();
    g.steps.push({
      id: "s99", type: "cook", label: "Floating step",
      optional: false, inferred: false, activeTimeEstimated: false, passiveTimeEstimated: false,
    });
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("ORPHAN_STEP");
  });

  it("catches a componentId with no matching component", () => {
    const g = fixture();
    g.steps[0].componentId = "cmp_ghost";
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("UNKNOWN_COMPONENT_REF");
  });

  it("catches a component parent cycle", () => {
    const g = fixture();
    g.components = [
      { id: "cmp_a", title: "A", parentId: "cmp_b" },
      { id: "cmp_b", title: "B", parentId: "cmp_a" },
    ];
    const codes = validateRecipeGraph(g).errors.map((e) => e.code);
    expect(codes).toContain("COMPONENT_PARENT_CYCLE");
  });
});

describe("validation warnings", () => {
  it("warns about an unused ingredient without erroring", () => {
    const g = fixture();
    g.edges = g.edges.filter((e) => e.from !== "ing_lemon");
    const result = validateRecipeGraph(g);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("lemon juice");
  });

  it("warns when a 'divided' ingredient is only used once", () => {
    const g = fixture();
    g.edges = g.edges.filter((e) => !(e.from === "ing_oil" && e.to === "s9"));
    const result = validateRecipeGraph(g);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("divided");
  });

  it("warns about a step with no path to a terminal", () => {
    const g = fixture();
    g.edges = g.edges.filter((e) => e.from !== "p8");
    const result = validateRecipeGraph(g);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("Grate Parmesan");
  });

  it("passes extraction warnings straight through", () => {
    const g = fixture();
    g.warnings = ["Serving size was not stated."];
    expect(validateRecipeGraph(g).warnings).toContain("Serving size was not stated.");
  });
});

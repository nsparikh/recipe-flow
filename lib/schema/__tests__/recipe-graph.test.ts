import { describe, it, expect } from "vitest";
import { RecipeGraphSchema } from "../recipe-graph";

describe("RecipeGraphSchema", () => {
  it("rejects a graph missing required fields", () => {
    expect(() => RecipeGraphSchema.parse({ title: "Soup" })).toThrow();
  });

  it("rejects an unknown step type", () => {
    const bad = {
      title: "x", components: [], ingredients: [], edges: [], terminalStepIds: [], warnings: [],
      steps: [{ id: "s1", type: "sauteing", label: "x", optional: false, inferred: false, activeTimeEstimated: false, passiveTimeEstimated: false }],
    };
    expect(() => RecipeGraphSchema.parse(bad)).toThrow();
  });

  it("requires the provenance flags on every step", () => {
    const bad = {
      title: "x", components: [], ingredients: [], edges: [], terminalStepIds: [], warnings: [],
      steps: [{ id: "s1", type: "cook", label: "x", optional: false }],
    };
    expect(() => RecipeGraphSchema.parse(bad)).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { RecipeGraphSchema, recipeGraphJsonSchema } from "../recipe-graph";

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

describe("recipeGraphJsonSchema", () => {
  // This schema is what constrains the extraction call. If its shape drifts, extraction breaks.
  it("is an object schema listing the graph's top-level fields as required", () => {
    expect(recipeGraphJsonSchema.type).toBe("object");
    expect(recipeGraphJsonSchema.required).toEqual(
      expect.arrayContaining(["title", "components", "ingredients", "steps", "edges", "terminalStepIds", "warnings"]),
    );
  });

  it("does not mark genuinely optional fields as required", () => {
    expect(recipeGraphJsonSchema.required).not.toContain("servings");
    expect(recipeGraphJsonSchema.required).not.toContain("sourceUrl");
  });

  it("serialises without circular references", () => {
    expect(() => JSON.stringify(recipeGraphJsonSchema)).not.toThrow();
  });
});

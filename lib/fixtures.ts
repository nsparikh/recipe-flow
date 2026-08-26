import { readFileSync } from "node:fs";
import path from "node:path";
import { RecipeGraphSchema, type RecipeGraph } from "./schema/recipe-graph";

/**
 * Loads the hand-authored golden fixtures. Server-side only.
 *
 * These stand in for extraction output until M3, so the render path can be developed and debugged
 * against a known-good graph without spending API calls.
 */

/** Order matters: the first entry is what loads by default. */
export const FIXTURES = [
  { slug: "garlic-butter-pasta", name: "Garlic Butter Pasta" },
  { slug: "minestrone", name: "Minestrone Soup" },
] as const;

export type FixtureSlug = (typeof FIXTURES)[number]["slug"];

export function isFixtureSlug(value: string | undefined): value is FixtureSlug {
  return FIXTURES.some((f) => f.slug === value);
}

export function loadFixture(slug: FixtureSlug): RecipeGraph {
  const file = path.join(process.cwd(), "fixtures", `${slug}.graph.json`);
  return RecipeGraphSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

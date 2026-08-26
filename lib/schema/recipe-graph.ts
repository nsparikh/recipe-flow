import { z } from "zod";

/**
 * The RecipeGraph schema — the single source of truth for the whole pipeline.
 *
 * TypeScript types are inferred from these Zod schemas, and the JSON Schema handed
 * to the Claude API during extraction is derived from them too (see `recipeGraphJsonSchema`).
 * Nothing else in the codebase should redeclare these shapes.
 */

/** A named sub-recipe ("the sauce", "the dough"). Only created when the recipe explicitly heads one. */
export const ComponentSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Undefined means top level. Enables arbitrary nesting depth. */
  parentId: z.string().optional(),
});

export const IngredientNodeSchema = z.object({
  id: z.string(),
  type: z.literal("ingredient"),
  name: z.string(),
  /** The TOTAL across the whole recipe, as written: "4 tbsp, divided". */
  quantity: z.string().optional(),
  /** Structured form, populated only when `quantity` parses cleanly. Enables serving scaling later. */
  amount: z.number().optional(),
  unit: z.string().optional(),
  /** "divided", "room temperature", "plus more to taste". */
  note: z.string().optional(),
  optional: z.boolean(),
  componentId: z.string().optional(),
});

/**
 * Passive-vs-active is NOT encoded here — it is derived in the topology layer from
 * `passiveTimeMin > activeTimeMin`. A 15-minute simmer is a `cook` step with passive time,
 * not a `rest`. `rest` is for cooling, marinating, proving — where nothing is being cooked.
 */
export const StepTypeSchema = z.enum(["prep", "cook", "assemble", "rest"]);

export const StepNodeSchema = z.object({
  id: z.string(),
  type: StepTypeSchema,
  /** Short enough to fit in a node box. */
  label: z.string(),
  /** Longer notes, doneness cues. */
  details: z.string().optional(),
  /** Verbatim span from the source recipe. For an inferred step, the ingredient line it came from. */
  sourceInstruction: z.string().optional(),
  /** "stove", "oven", "counter", "sink". The grouping key for the future swimlane view. */
  station: z.string().optional(),
  equipment: z.array(z.string()).optional(),
  /** Hands-on minutes. */
  activeTimeMin: z.number().optional(),
  /** Unattended minutes. This is what the parallelism story is built on. */
  passiveTimeMin: z.number().optional(),
  temperature: z.string().optional(),
  optional: z.boolean(),
  componentId: z.string().optional(),
  /** True when the step was decomposed out of an ingredient line rather than written as an instruction. */
  inferred: z.boolean(),
  /** True when the duration was estimated rather than stated by the recipe. Drives the `~` prefix. */
  activeTimeEstimated: z.boolean(),
  passiveTimeEstimated: z.boolean(),
});

/**
 * `ingredient`   — a raw ingredient entering a step.
 * `intermediate` — a step's product feeding the next step, worth naming ("aromatic base").
 * `sequence`     — pure ordering with no transfer, typically the same vessel continuing.
 *
 * The intermediate/sequence distinction is a rendering hint, not a correctness property.
 */
export const EdgeTypeSchema = z.enum(["ingredient", "intermediate", "sequence"]);

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: EdgeTypeSchema,
  /** The PORTION consumed at this step ("3 tbsp"), not the ingredient's total. */
  quantity: z.string().optional(),
  label: z.string().optional(),
});

export const RecipeGraphSchema = z.object({
  title: z.string(),
  servings: z.string().optional(),
  sourceUrl: z.string().optional(),
  /** Empty for recipes without explicitly headed sub-recipes. */
  components: z.array(ComponentSchema),
  ingredients: z.array(IngredientNodeSchema),
  steps: z.array(StepNodeSchema),
  edges: z.array(EdgeSchema),
  /** The recipe's final output(s). Component-level terminals are derived, not stored. */
  terminalStepIds: z.array(z.string()),
  /** Ambiguities the extraction step chose to surface rather than silently guess. */
  warnings: z.array(z.string()),
});

export type Component = z.infer<typeof ComponentSchema>;
export type IngredientNode = z.infer<typeof IngredientNodeSchema>;
export type StepType = z.infer<typeof StepTypeSchema>;
export type StepNode = z.infer<typeof StepNodeSchema>;
export type EdgeType = z.infer<typeof EdgeTypeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type RecipeGraph = z.infer<typeof RecipeGraphSchema>;

/** Any addressable node in the graph. */
export type GraphNode = IngredientNode | StepNode;

export function isIngredientNode(node: GraphNode): node is IngredientNode {
  return node.type === "ingredient";
}

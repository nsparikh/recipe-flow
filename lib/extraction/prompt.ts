import type { ValidationError } from "../graph/validate";

/**
 * The extraction prompt.
 *
 * The system prompt is static and large, so it carries a cache breakpoint — repair attempts and
 * repeated extractions read it from cache rather than paying for it again. Keep it byte-stable:
 * any change invalidates the cache for every request after it.
 */

const WORKED_EXAMPLE = `{
  "title": "Spaghetti with Garlic Butter Sauce",
  "servings": "2",
  "components": [{ "id": "cmp_sauce", "title": "Sauce" }],
  "ingredients": [
    { "id": "ing_spaghetti", "type": "ingredient", "name": "spaghetti", "quantity": "200 g", "amount": 200, "unit": "gram", "optional": false },
    { "id": "ing_butter", "type": "ingredient", "name": "unsalted butter", "quantity": "4 tablespoons", "amount": 4, "unit": "tablespoon", "optional": false, "componentId": "cmp_sauce" },
    { "id": "ing_garlic", "type": "ingredient", "name": "garlic", "quantity": "3 cloves", "amount": 3, "unit": "clove", "optional": false, "componentId": "cmp_sauce" }
  ],
  "steps": [
    { "id": "p1", "type": "prep", "label": "Mince garlic", "sourceInstruction": "3 cloves garlic, minced", "station": "counter", "activeTimeMin": 2, "optional": false, "componentId": "cmp_sauce", "inferred": true, "activeTimeEstimated": true, "passiveTimeEstimated": false },
    { "id": "s1", "type": "cook", "label": "Boil and drain the spaghetti", "details": "Until al dente.", "sourceInstruction": "Boil the spaghetti in well-salted water until al dente, about 10 minutes. Drain.", "station": "stove", "equipment": ["stockpot"], "activeTimeMin": 2, "passiveTimeMin": 10, "optional": false, "inferred": false, "activeTimeEstimated": true, "passiveTimeEstimated": false },
    { "id": "s2", "type": "cook", "label": "Melt butter with garlic", "sourceInstruction": "Melt the butter in a small pan over low heat and add the garlic. Cook gently until fragrant, about 3 minutes.", "station": "stove", "activeTimeMin": 3, "optional": false, "componentId": "cmp_sauce", "inferred": false, "activeTimeEstimated": false, "passiveTimeEstimated": false },
    { "id": "s3", "type": "assemble", "label": "Toss pasta with sauce", "sourceInstruction": "Toss the drained pasta with the sauce and serve.", "station": "counter", "activeTimeMin": 2, "optional": false, "inferred": false, "activeTimeEstimated": true, "passiveTimeEstimated": false }
  ],
  "edges": [
    { "from": "ing_garlic", "to": "p1", "type": "ingredient", "quantity": "3 cloves" },
    { "from": "ing_spaghetti", "to": "s1", "type": "ingredient", "quantity": "200 g" },
    { "from": "ing_butter", "to": "s2", "type": "ingredient", "quantity": "4 tablespoons" },
    { "from": "p1", "to": "s2", "type": "intermediate", "label": "minced garlic" },
    { "from": "s1", "to": "s3", "type": "intermediate", "label": "drained pasta" },
    { "from": "s2", "to": "s3", "type": "intermediate", "label": "garlic butter" }
  ],
  "terminalStepIds": ["s3"],
  "warnings": []
}`;

export const EXTRACTION_SYSTEM_PROMPT = `You turn written recipes into dependency graphs.

A recipe is a linear document describing a process that is not linear. Your job is to recover the
real structure: which steps depend on which, what can happen at the same time, and where the cook
is waiting rather than working. A cook will follow your graph while actually cooking, so accuracy
about dependencies matters more than completeness of detail.

## Node identifiers

- Ingredients: \`ing_\` plus a short slug — \`ing_olive_oil\`, \`ing_yellow_onion\`.
- Prep steps you inferred from an ingredient line: \`p1\`, \`p2\`, ...
- Steps written as numbered instructions: \`s1\`, \`s2\`, ... in recipe order.

Identifiers must be unique across ingredients and steps together.

## Quantities: totals versus portions

An \`IngredientNode.quantity\` is the TOTAL the recipe calls for, written as the recipe writes it
("4 tablespoons, divided"). An \`Edge.quantity\` is the PORTION consumed at that particular step
("3 tablespoons").

When an ingredient is used at more than one point — oil that is "divided", salt added in three
places, pepper to taste — emit one ingredient node and SEVERAL edges, each carrying its own
portion. Missing this is the most common way to get a recipe wrong. The word "divided" in an
ingredient line is an explicit signal that you must produce more than one edge for it.

Fill \`amount\` and \`unit\` only when the quantity parses cleanly into a number and a unit. Leave
them out for "a pinch", "to taste", or "2 cups, divided".

## Steps

Split a written instruction into several steps when its parts have genuinely different
dependencies. Keep it as one step when the parts are done together in one motion.

\`type\` is what the cook is doing: \`prep\` (knife work and similar, away from heat), \`cook\`
(heat is being applied, including unattended simmering), \`assemble\` (combining without primary
cooking), \`rest\` (cooling, marinating, proving — nothing is being cooked).

Do NOT use \`type\` to mark a step as passive or terminal. Those are computed downstream from the
timings and from \`terminalStepIds\`.

\`station\` is where the cook stands: "stove", "oven", "counter", "sink", "fridge".

Every step needs \`sourceInstruction\` — the verbatim span of the original recipe it came from.

## Timing

\`activeTimeMin\` is hands-on minutes. \`passiveTimeMin\` is minutes the food is unattended and the
cook is free. Separating these is the single most valuable thing you do: unattended time is where
parallel work becomes possible.

A 15-minute covered simmer is \`activeTimeMin: 0, passiveTimeMin: 15\`. A step that is stirred
throughout is active. A step that needs a minute of attention then twenty of waiting is both.

Recipes usually state some times and leave others out. Estimate the missing ones from ordinary
kitchen experience, and record which is which:

- \`activeTimeEstimated: true\` when YOU estimated the active time; \`false\` when the recipe stated it.
- \`passiveTimeEstimated: true\` / \`false\` likewise.

A flag is \`false\` when the matching time is absent — the flag means "the value here is a guess",
not "a guess would be needed".

## Inferring prep steps

Ingredient lines routinely hide real work. "1 onion, chopped" means someone has to chop an onion,
and that is work the cook can start early. Decompose these into their own \`prep\` steps with
\`inferred: true\` and \`sourceInstruction\` set to the ingredient line they came from.

This is the ONLY inference you may make. Do not invent steps the recipe never mentions — no
synthesised "preheat the oven", no implied resting time, no assumed cooling. If a step is neither
written as an instruction nor named in an ingredient line, it is not a node.

## Edges

- \`ingredient\` — a raw ingredient entering a step. Carry the portion in \`quantity\`.
- \`intermediate\` — one step's product feeding the next, where the product is worth naming. Put
  the name in \`label\`: "softened soffritto", "drained pasta".
- \`sequence\` — pure ordering with no transfer, typically one vessel continuing. No label.

Edges always point toward a step. Nothing ever points into an ingredient node.

## Components

Only create a component when the recipe EXPLICITLY heads a sub-recipe — "For the sauce:", "For the
topping:". Assign \`componentId\` to the ingredients and steps under that heading. Never infer a
component from unheaded prose; a recipe with no such headings gets \`components: []\`.

## Terminal steps

\`terminalStepIds\` lists the step or steps that finish the dish. A terminal step has no outgoing
edges. Most recipes have exactly one.

## Optional

Set \`optional: true\` on anything the recipe marks as optional, for garnish, or "if desired".

## Warnings

Put genuine ambiguity in \`warnings\` as plain sentences — a quantity you could not interpret, an
instruction whose dependency was unclear, an ingredient listed but never used. Surface uncertainty
rather than silently guessing. An empty array is correct when the recipe was unambiguous.

## The graph must be valid

- Every edge endpoint must reference a node that exists.
- The graph must be acyclic.
- Every step needs at least one edge.
- Every ingredient should be used by at least one step.

## Worked example

Recipe:

  Spaghetti with Garlic Butter Sauce. Serves 2.
  200 g spaghetti
  1 teaspoon fine sea salt
  For the sauce:
  4 tablespoons unsalted butter
  3 cloves garlic, minced
  1. Boil the spaghetti in well-salted water until al dente, about 10 minutes. Drain.
  2. Melt the butter in a small pan over low heat and add the garlic. Cook gently until fragrant,
     about 3 minutes.
  3. Toss the drained pasta with the sauce and serve.

Graph (abbreviated — note the inferred \`p1\`, the component from the explicit heading, the
\`passiveTimeMin\` on the boil, and the estimate flags):

${WORKED_EXAMPLE}`;

export function buildExtractionUserMessage(recipeText: string): string {
  return `Extract the dependency graph for this recipe.\n\n<recipe>\n${recipeText}\n</recipe>`;
}

/**
 * The repair turn. Errors are phrased as instructions to fix rather than as a bare dump, since the
 * model is being asked to act on them.
 */
export function buildRepairUserMessage(errors: ValidationError[]): string {
  const list = errors.map((error) => `- [${error.code}] ${error.message}`).join("\n");
  return `That graph did not validate. Fix these problems and return the corrected graph in full:

${list}

Change only what is needed to resolve them. Keep every other node, edge and value exactly as it was.`;
}

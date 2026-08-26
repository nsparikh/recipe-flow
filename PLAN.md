# Recipe Flow — Technical Plan

> Working document. Updated as decisions are made. Last updated: 2026-08-26.

## 1. Problem & Goal

A recipe is a linear document describing a fundamentally non-linear process. Standard recipes
bury the dependency structure — what blocks what, what can run in parallel, what's idle time you
could be using — inside prose ordering.

**Goal:** take a text recipe as input, extract its true dependency graph, and render it as a
flowchart a cook can follow while actually cooking.

**Scope:** MVP / proof-of-concept. Not production-ready. No auth, no database, no multi-user.

## 2. Decisions Made

| Decision | Choice | Notes |
|---|---|---|
| Input | Paste text **and** URL fetch | URL path tries JSON-LD first, falls back to stripped page text |
| Renderer (MVP) | Mermaid | Rendered client-side. Topology layer stays renderer-agnostic for future views |
| Future renderers | Swimlanes, interactive canvas | Not built now, but the seam is designed in (see §6) |
| API key | Server-side env var (`ANTHROPIC_API_KEY`) | Never reaches the browser |
| Interactivity (MVP) | Static diagram, pan/zoom only | No cook-along state yet |
| Persistence | `localStorage` | Stores the **graph**, not the rendered output. Keyed by input hash |
| Framework | Next.js 15 App Router on Vercel | Already scaffolded |
| Model | `claude-opus-5` | Adaptive thinking, structured outputs, streamed |
| Inferred prep steps | **Yes** — extraction decomposes ingredient-line prep into step nodes | Marked `inferred: true` |
| Inferred times | **Yes** — estimate when the recipe is silent, distinguish subtly | `~` prefix convention, see §7 |
| Sub-recipes | Nested subgraphs, **flat representation + group membership** | See §4 "Components" |
| Serving scaling | Out of scope for MVP, door kept open | Structured quantity fields captured now (§4) |
| Graph editing | Out of scope for MVP, door kept open | Enabled by pure `graph → topology → render` (§6) |
| Component boundaries | Only group when the recipe **explicitly marks** it | No inferring unheaded components |
| Inference boundary | Stops at **ingredient-line prep** | No inventing steps the recipe never mentions |

## 3. Architecture

Follows the sketch in [docs/architecture-sketch.jpeg](docs/architecture-sketch.jpeg).

```
  recipe text ──┐
                ├──> [ extract ] ──> RecipeGraph (JSON) ──> [ validate ] ──> [ derive topology ]
  recipe URL ───┘         ^                                       │                    │
                          │                                       │                    ├──> [ render mermaid ]   ← MVP
                          └───────────── errors (repair loop) ────┘                    ├──> [ render swimlanes ] ← later
                                                                                       └──> [ other views ]      ← later
```

Five stages, each independently testable:

1. **Ingest** — normalize input to plain recipe text (paste = passthrough; URL = fetch + extract).
2. **Extract** — one Claude call, prose → `RecipeGraph` JSON, constrained by schema.
3. **Validate** — structural checks. Errors feed back into a bounded repair loop; warnings pass through.
4. **Derive topology** — enrich the validated graph with layout-independent facts (layers, critical
   path, parallelism, station and component grouping). **This is the renderer-agnostic seam.**
5. **Render** — topology → view. Mermaid now; swimlanes and interactive canvas later.

The core logic — stages 2–4 — is all pure TypeScript in `lib/`, with no React and no Next.js
imports. It can be unit-tested and run from a script without a server.

## 4. Data Model

Follows [docs/data-model-sketch.jpeg](docs/data-model-sketch.jpeg), with additions marked `+`.

Defined once as Zod schemas in `lib/schema/recipe-graph.ts`. TypeScript types are inferred from
Zod; the JSON Schema handed to the Claude API is *derived* from the same Zod schema. One source of
truth — the schema can't drift from the types or from what the model is told to produce.

```ts
RecipeGraph {
  title: string
  servings?: string
  sourceUrl?: string
  components: Component[]     // + sub-recipes; empty for simple recipes
  ingredients: IngredientNode[]
  steps: StepNode[]
  edges: Edge[]
  terminalStepIds: string[]   // the recipe's final output(s)
  warnings: string[]
}

Component {                   // + a named sub-recipe: "the sauce", "the dough"
  id: string                  // "cmp_sauce"
  title: string               // "Sauce"
  parentId?: string           // nesting; undefined = top level
}

IngredientNode {
  id: string                  // stable slug, e.g. "ing_olive_oil"
  type: "ingredient"
  name: string
  quantity?: string           // TOTAL, as written: "4 tbsp, divided"
  amount?: number             // + structured, when cleanly parseable: 4
  unit?: string               // + structured: "tbsp"
  note?: string               // "divided", "room temperature"
  optional: boolean           // +
  componentId?: string        // + which sub-recipe it belongs to
}

StepNode {
  id: string                  // "p1", "s3", ...
  type: "prep" | "cook" | "assemble" | "rest"   // +
  label: string               // short, fits in a node box
  details?: string            // longer notes / doneness cues
  sourceInstruction?: string  // verbatim span from the original (provenance)
  station?: string            // "stove", "oven", "counter" — the future swimlane key
  equipment?: string[]
  activeTimeMin?: number      // hands-on
  passiveTimeMin?: number     // unattended — what parallelism is built on
  temperature?: string
  optional: boolean           // +
  componentId?: string        // + which sub-recipe it belongs to
  inferred: boolean           // + step not stated as its own instruction (Q1)
  activeTimeEstimated: boolean  // + (Q2)
  passiveTimeEstimated: boolean // + (Q2)
}

Edge {
  from: string                // node id (ingredient or step)
  to: string                  // step id
  type: "ingredient" | "intermediate" | "sequence"   // +
  quantity?: string           // PORTION at this step: "3 tbsp"
  label?: string              // "softened soffritto"
}
```

### Modeling notes

- **Ingredients split across steps.** Olive oil is "4 tbsp, divided" — 3 tbsp into the sauté, 1 tbsp
  at the finish. Salt is added three separate times. So `IngredientNode.quantity` is the recipe
  total and `Edge.quantity` is the portion used at that edge. This is exactly why the sketch put an
  optional quantity on `Edge`, and it's load-bearing.
- **Edge types.** `ingredient` = raw ingredient into a step. `intermediate` = a step's product feeds
  the next step and is worth naming ("aromatic base"). `sequence` = pure ordering with no transfer,
  typically the same vessel continuing (`s4 → s5 → s6`). The intermediate/sequence line is soft;
  treat it as a rendering hint, not a correctness property.
- **Derived, not stored.** `terminal` and `passive` are *not* node types. Terminal = id appears in
  `terminalStepIds`. Passive = `passiveTimeMin > activeTimeMin`. Computing these in the topology
  layer keeps the extraction schema smaller and removes a class of model self-contradiction.
- **`station` is the swimlane key.** The sketch already anticipated the swimlane view by putting
  station on `StepNode`. Nothing more is needed in the schema to support that renderer later.

### Components (Q3) — nested visually, flat structurally

Sub-recipes render as **nested Mermaid subgraphs**, but are represented as a **flat node list plus
group membership** (`componentId`), not as a recursive graph-within-a-graph.

This is deliberate, and it's the more correct model rather than merely the easier one:

- Real sub-recipes **feed each other** — the sauce flows into the assembly. Under a flat model those
  are ordinary edges. Under a truly recursive model every such edge has to cross a container
  boundary, which is the awkward case, and it's the common case.
- Validation, cycle detection, and topology all keep operating on one flat node set. No recursive
  variants of any algorithm.
- It's the same shape as `station` grouping — one flat node set, several independent groupings over
  it. `byComponent` and `byStation` are the same kind of thing.
- `Component.parentId` gives arbitrary nesting depth for free. MVP renders one level; deeper nesting
  needs no schema change.

Component-level terminals (the step where a sub-recipe is "done") are **derived** in the topology
layer — the step in a component whose outgoing edges leave that component — consistent with the
"derive, don't store" principle above.

### Keeping the door open

- **Scaling (Q4).** `amount` + `unit` are captured alongside the display string `quantity`. Scaling
  later becomes a pure transform over the graph rather than a re-extraction, and costs essentially
  nothing to capture now. When a quantity isn't cleanly parseable ("a pinch", "2 cups, divided"),
  the structured fields are simply absent and `quantity` still displays correctly.
- **Editing (Q5).** Guaranteed by the architecture rather than by a feature: `graph → topology →
  render` are pure functions, so editing later means mutating the graph and re-running the same
  pipeline. Two concrete requirements this imposes now — (a) `localStorage` persists the
  **`RecipeGraph`**, never the rendered Mermaid string; (b) no renderer may depend on anything only
  the extraction step knows. Both are already true in this design.

## 5. Extraction Layer

The core of the project.

**Call shape** (`lib/extraction/extract.ts`):

- Model `claude-opus-5`, adaptive thinking (`thinking: { type: "adaptive" }`), `effort: "high"`.
- Structured outputs via `output_config.format` with the JSON Schema derived from Zod, so the
  response validates against the schema at the API layer rather than in a hand-written parser.
- **Streamed**, with `.finalMessage()` to collect the result. Two reasons: a full graph is a large
  output, and streaming holds the connection open past Vercel's function timeout (see §10).
- Prompt caching on the system prompt (it's static and large — schema explanation, ID conventions,
  worked example), so repair-loop retries and repeated extractions hit cache.

**Prompt design** (`lib/extraction/prompt.ts`): a static system prompt carrying the schema
explanation, ID naming conventions, the rules below, and one abbreviated worked example. The recipe
text goes in the user turn, after the cache breakpoint.

**Extraction rules the prompt must pin down:**

- **Decompose ingredient-line prep into its own step nodes** — "1 onion, chopped" becomes an
  ingredient node plus a `prep` step, because that's real work the cook can start early. Mark these
  `inferred: true`, and point `sourceInstruction` at the ingredient line they came from. *(Q1)*
- **Estimate `activeTimeMin` / `passiveTimeMin` when the recipe doesn't state them**, and set the
  corresponding `*Estimated` flag. Times lifted directly from the recipe text keep the flag false.
  *(Q2)*
- Split compound instructions into separate steps when they have distinct dependencies.
- Separate active from passive time explicitly — this is what the whole parallelism story rests on.
- Assign `componentId` **only** when the recipe explicitly marks a sub-recipe with its own section
  heading ("For the sauce:"). Never infer component boundaries from unheaded prose. *(Q6)*
- **Inference stops at ingredient-line prep.** Do not invent steps the recipe never mentions —
  no synthesized "preheat the oven", no implied resting periods. If a step isn't either written as
  an instruction or named in an ingredient line, it doesn't become a node. *(Q7)*
- Fill `amount` / `unit` only when a quantity parses cleanly; leave them absent otherwise.
- Record `sourceInstruction` for every step so output can be traced back to the original text.
- Put genuine ambiguity in `warnings` rather than silently guessing.

**Repair loop** (the errors arrow in the sketch): if validation fails, send the invalid graph plus
the structured error list back to the model and ask for a corrected graph. Bounded at **2 retries**,
then surface the errors to the user rather than looping. Repair attempts reuse the cached system
prompt.

## 6. Validation & Topology

### Validation (`lib/graph/validate.ts`)

Pure function, `RecipeGraph → { errors: ValidationError[], warnings: string[] }`.

**Errors** — structural, trigger the repair loop:
- Duplicate node IDs
- Edge endpoint referencing a nonexistent node
- Edge pointing *to* an ingredient node (ingredients are always sources)
- Cycle in the graph (it must be a DAG)
- A step in `terminalStepIds` that has outgoing edges
- A step with no incoming edges *and* no outgoing edges (fully orphaned)
- `componentId` referencing a nonexistent component; cycle in `Component.parentId`

**Warnings** — semantic, surfaced to the cook, never block:
- Ingredient with no outgoing edges (declared but never used)
- Step with no path to any terminal step (dead-end work)
- Multiple terminal steps (may be legitimate — components served together)
- Ingredient whose edge quantities don't obviously reconcile with its total
- A component whose steps never connect to the rest of the graph
- Whatever the model itself flagged during extraction

### Topology (`lib/graph/topology.ts`)

Pure function, validated `RecipeGraph → RecipeTopology`. Everything a renderer needs that isn't
the raw graph, and nothing view-specific:

- `order` — topological sort
- `depth` per node — longest-path layering, i.e. earliest layer a step can start in
- `criticalPath` — longest path by `activeTimeMin + passiveTimeMin` to each terminal
- `earliestStart` / `slack` per step — the scheduling data behind "start this while that simmers"
- `parallelGroups` — sets of steps with no dependency between them
- `byStation` — grouping for the future swimlane view
- `byComponent` — grouping for subgraph rendering, plus each component's derived terminal step
- `flags` — `isTerminal`, `isPassive`, `isOptional`, `isInferred`, `onCriticalPath`

The Mermaid renderer only consumes a slice of this. The rest exists so the swimlane and cook-along
views can be added without touching extraction or validation.

**Caveat worth tracking:** since times may be estimated (Q2), anything derived from them —
`criticalPath`, `slack`, `earliestStart` — is partly estimated too. The scheduling output is a
useful guide, not a promise, and the UI shouldn't present it as precise.

## 7. Rendering

`lib/render/mermaid.ts` — `RecipeTopology → string` (Mermaid `flowchart LR` source). Pure, no DOM,
so it's snapshot-testable. Reproduces the styling of the reference minestrone diagram: rounded nodes
for ingredients, rectangles for steps, `classDef` for ingredient / passive / terminal / optional,
edge labels carrying `Edge.quantity` or `Edge.label`.

**Components** render as Mermaid `subgraph` blocks, one per `Component`, nested by `parentId`.
Edges between components are ordinary edges and need no special handling.

**Distinguishing inferred content subtly** *(Q1, Q2)*:

- **Estimated times** get a `~` prefix — `~3m` vs. `8m`. This is already the convention in the
  reference minestrone diagram: the inferred prep steps read `~3m`, `~4m`, `~2m` while the stated
  cook times read `1m`, `8m`, `2m`. It's legible, needs no styling, and can't collide with anything.
- **Inferred steps** get their own `classDef` with a muted stroke. Deliberately *not* dashed —
  `stroke-dasharray` is already spoken for by `optional`, and a node can be both.
- A short legend below the diagram explains both, so `~` isn't a mystery.

Future views plug in at the same seam, each a `RecipeTopology → view` function. No change to
stages 1–4.

## 8. API Routes

| Route | Method | In | Out |
|---|---|---|---|
| `/api/extract` | POST | `{ text }` or `{ url }` | `{ graph, warnings, mermaid }` or `{ errors }` |

One route, because the URL path is just an extra ingest step in front of the same pipeline.

**URL ingest** (`lib/extraction/fetch-page.ts`), in order:
1. Fetch the page.
2. Look for a `schema.org/Recipe` JSON-LD block. Most recipe sites publish one, and it gives clean
   ingredients and instructions with no scraping heuristics. Big reliability win when present.
3. Fall back to stripping `<script>`/`<style>`/nav, collapsing whitespace, capping at ~50k chars,
   and letting Claude locate the recipe in the noise.

Known failure modes to surface clearly rather than paper over: paywalls, JS-rendered pages, and
bot blocking. The paste path is always the fallback.

## 9. Repo Structure

```
app/
  page.tsx                    # input form + result view
  api/extract/route.ts
lib/
  schema/recipe-graph.ts      # Zod schemas → TS types → JSON Schema
  extraction/
    prompt.ts
    extract.ts                # Claude call + repair loop
    fetch-page.ts             # URL → recipe text
  graph/
    validate.ts
    topology.ts
  render/
    mermaid.ts
components/
  RecipeInput.tsx
  MermaidDiagram.tsx
  WarningList.tsx
fixtures/
  minestrone.txt              # source text
  minestrone.graph.json       # hand-authored expected graph (golden fixture)
docs/
  architecture-sketch.jpeg
  data-model-sketch.jpeg
```

## 10. Risks & Constraints

- **Vercel function timeout.** A high-effort Opus 5 extraction can run well past the default limit.
  Mitigation: stream the Claude response (holds the connection open) and set `maxDuration` on the
  route. If it's still tight, the fallback is to stream progress to the client rather than
  request/response.
- **Cost per extraction.** Opus 5 with high effort on a full recipe is a real per-call cost, and the
  deployed key is yours. Prompt caching helps on retries. If the URL gets shared around, add a rate
  limit.
- **Extraction quality is the whole project.** The failure mode to watch is a *plausible* graph with
  a subtly wrong dependency — worse than an obviously broken one, because validation can't catch it.
  The golden fixture exists to make regressions visible.
- **Inference widens that surface.** Q1 and Q2 mean the app now invents steps and estimates times
  the recipe never stated. That's where most of the parallelism value comes from, but a wrong
  inferred step is indistinguishable from a real one to a cook who hasn't read the source. The `~`
  marker and the inferred-step styling are the mitigation; honest estimates matter more than
  confident ones.
- **Mermaid layout on large graphs.** ~40 nodes renders acceptably; nested subgraphs plus a denser
  recipe may push the custom layout renderer earlier than planned.

## 11. Open Questions

**Resolved 2026-08-26** — Q1 infer prep steps (yes, flagged), Q2 estimate times (yes, `~` prefix),
Q3 sub-recipes (nested subgraphs, flat representation), Q4 scaling (out of scope, structured
quantities captured), Q5 editing (out of scope, architecture keeps it open). All folded into the
sections above.

**Also resolved 2026-08-26** — Q6 component boundaries (only group when the recipe explicitly marks
it), Q7 inference boundary (stops at ingredient-line prep; nothing invented beyond it). Both folded
into the extraction rules in §5.

Both are deliberately conservative, and both are looseable later without a schema change — the
fields already exist, only the prompt would change. The reverse would not be true, which is why
starting tight is the cheaper direction.

**Currently open:**

- **Q8 — Component fixture coverage.** The minestrone fixture has no sub-recipes, so `components`
  and `componentId` are exercised only in their empty state. A second fixture with an explicitly
  headed sub-recipe is needed before M3 to prove the nesting path end to end.

## 12. Milestones

- **M0 — Scaffolding.** ✅ Next.js app, hello-world page, Vercel CLI installed.
- **M1 — Schema + validation.** ✅ Zod schemas (`lib/schema/recipe-graph.ts`), hand-authored
  minestrone fixture (`fixtures/`), validation rules (`lib/graph/validate.ts`), 25 unit tests.
  No LLM involved. The fixture is 21 ingredients / 18 steps / 42 edges, matching the reference
  diagram, and validates clean with zero warnings.
- **M2 — Topology + Mermaid renderer.** Render the fixture graph end-to-end to a diagram in the
  browser. Proves the render path without spending a single API call.
- **M3 — Extraction (paste).** Claude call, structured outputs, repair loop, wired to the UI.
  First real end-to-end run. Compare output against the golden fixture.
- **M4 — URL ingest.** JSON-LD path plus text fallback.
- **M5 — Polish + deploy.** Warning surfacing, loading and error states, `localStorage` history,
  production deploy.

Ordering M2 before M3 is deliberate: it makes the rendering path debuggable against a known-good
graph, so when extraction lands, any bad diagram is unambiguously an extraction problem.

# Recipe Flow — Technical Plan

> Working document. Updated as decisions are made. Last updated: 2026-08-26.
>
> **Live:** https://recipe-flow-alpha.vercel.app

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
| API key | **User-supplied in the browser**, kept in `localStorage` | Sent per request as a header; never stored server-side |
| Interactivity (MVP) | Static diagram, pan/zoom only | No cook-along state yet |
| Persistence | `localStorage` | API key, plus the last 10 extracted **graphs**. Never the rendered output |
| Framework | Next.js 15 App Router on Vercel | Already scaffolded |
| Model | `claude-sonnet-5`, `effort: "medium"` | Chosen for cost while the prompt settles. One constant pair in `extract.ts`; Opus 5 / high is the quality ceiling |
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

- Model and effort are two exported constants at the top of `extract.ts` — the single place to tune
  cost. Currently `claude-sonnet-5` at `effort: "medium"`, with adaptive thinking
  (`thinking: { type: "adaptive" }`). Extraction is a well-specified structured task, so the
  cheapest configuration that does it well is the right default while the prompt is still moving.
  `claude-opus-5` at `effort: "high"` is the ceiling if extraction starts missing dependencies.
  Worth eventually exposing to users alongside their key, since they pay for it.
- Structured outputs via `output_config.format` using the SDK's `zodOutputFormat(RecipeGraphSchema)`
  helper, which converts the Zod schema and validates the response into `parsed_output`. No
  hand-written parser and no separate JSON Schema to keep in sync.
- **Streamed**, with `.finalMessage()` to collect the result. Two reasons: a full graph is a large
  output, and streaming holds the connection open past Vercel's function timeout (see §10).
  `max_tokens` is 32000 — comfortably above a full recipe graph.
- The client is injectable, so the repair loop is unit-tested against a stub with no API calls.
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
- `projectDurationMin` — wall clock with perfect parallelism (the critical path length)
- `sequentialDurationMin` — wall clock doing every step one at a time
- `totalActiveMin` / `totalPassiveMin` — hands-on versus unattended

The gap between `sequentialDurationMin` and `projectDurationMin` is the number that justifies the
whole app. For the minestrone fixture it is 82 minutes versus 62 — twenty minutes recovered purely
by reordering work the recipe already described.

The Mermaid renderer only consumes a slice of this. The rest exists so the swimlane and cook-along
views can be added without touching extraction or validation.

**Two caveats worth tracking:**

1. Since times may be estimated (Q2), anything derived from them — `criticalPath`, `slack`,
   `earliestStart` — is partly estimated too. The scheduling output is a useful guide, not a
   promise, and the UI shouldn't present it as precise.
2. The schedule is classic critical-path method, which **assumes unlimited hands**. It reports the
   theoretical best case: every independent step running at once. One cook cannot chop an onion and
   mince garlic simultaneously, so real elapsed time lands between `projectDurationMin` and
   `sequentialDurationMin`. Modelling a single cook properly is resource-constrained scheduling,
   which is a much harder problem and deliberately out of scope. Worth revisiting if the numbers
   start feeling dishonest in practice.

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
| `/api/extract` | POST | `{ text }` or `{ url }`, plus `x-anthropic-api-key` | `{ graph, view, usage }` or `{ error, errors }` |

One route, because the URL path is just an extra ingest step in front of the same pipeline.

### API key handling

Every user brings their own Anthropic key. It is entered on the page, kept in that browser's
`localStorage`, and sent as the `x-anthropic-api-key` header on each extraction request. The server
uses it to construct the client for that one call and never logs, stores, or environment-reads it —
there is deliberately no `ANTHROPIC_API_KEY` fallback, so nobody can accidentally spend someone
else's credits.

**The trade-off, stated plainly:** the key does travel through the server, because that is where the
Anthropic call is made. Anyone given the deployed URL is trusting that server with their key. The
alternative is calling Anthropic straight from the browser with the SDK's `dangerouslyAllowBrowser`
flag, which keeps the key on the user's machine entirely — at the cost of shipping the extraction
pipeline to the client and losing the server-side seam that M4's URL fetch needs anyway (browsers
cannot fetch arbitrary recipe pages, CORS blocks it). Worth revisiting if this is ever shared beyond
people who already trust the deployer.

**URL ingest** (`lib/extraction/fetch-page.ts`), in order:
1. Guard the URL (see below), then fetch with a 15s timeout and an honest user agent.
2. Look for a `schema.org/Recipe` JSON-LD block. Most recipe sites publish one, and it gives clean
   ingredients and instructions with no scraping heuristics. Verified against the reference
   minestrone URL: clean ingredients and instructions, entities decoded, and the recipe's own stated
   times pulled through.
3. Fall back to stripping `<script>`/`<style>`/nav, collapsing whitespace, capping at 50k chars, and
   letting the model locate the recipe in the noise.

`HowToSection` names in JSON-LD are preserved as `For the X:` headings, which is exactly the
explicit sub-recipe marker the extraction prompt looks for (Q6). Structured data feeding component
detection is a nice accident of the two designs lining up.

Failure modes are surfaced specifically rather than as one generic error — paywalls (401/402), bot
blocking (403), rate limiting (429), missing pages, non-HTML responses, and pages whose recipe never
appears in the HTML. Every message points back to pasting, which always works.

### SSRF guarding

The server fetches whatever URL it is handed, so without a guard a visitor could use it to read
addresses only the server can reach — cloud metadata endpoints being the classic target. Blocked:
non-http(s) schemes, loopback, private IPv4 ranges, link-local (including `169.254.169.254`), IPv6
unique-local and link-local, and dotless or `.local`/`.internal` names. Redirects are re-checked
after the fact, since a public URL can redirect somewhere private.

**Known limitation:** this checks the hostname as written. A public domain that *resolves* to a
private address still gets through (DNS rebinding). Closing that needs resolve-then-check-then-connect
against the resolved IP, which is more than a prototype warrants — but it is a real hole, and worth
fixing before this is exposed to anyone untrusted.

## 9. Repo Structure

```
app/
  page.tsx                    # loads fixtures, renders the workbench
  api/extract/route.ts        # POST { text } -> { graph, view, usage }
  globals.css
lib/
  schema/recipe-graph.ts      # Zod schemas -> TS types (and the API output format)
  extraction/
    prompt.ts                 # cached system prompt + repair turn
    extract.ts                # streamed Claude call + repair loop
    fetch-page.ts             # URL -> recipe text                      (M4)
  graph/
    validate.ts
    topology.ts
  render/
    mermaid.ts
  view-model.ts               # graph -> everything the UI needs
  fixtures.ts                 # server-side fixture loading
components/
  RecipeWorkbench.tsx         # paste box, extraction state, fixture switcher
  RecipeView.tsx              # one recipe, fixture or extracted alike
  MermaidDiagram.tsx
fixtures/
  minestrone.{txt,graph.json}            # golden fixture, no components
  garlic-butter-pasta.{txt,graph.json}   # golden fixture, one headed sub-recipe
docs/
  architecture-sketch.jpeg
  data-model-sketch.jpeg
```

`RecipeView` is the reason fixtures and extractions look identical on screen: both paths build the
same `RecipeView` model, so the display component has no idea which it is showing.

## 10. Risks & Constraints

- **Vercel function timeout.** A high-effort Opus 5 extraction can run well past the default limit.
  Mitigation: stream the Claude response (holds the connection open) and set `maxDuration` on the
  route. If it's still tight, the fallback is to stream progress to the client rather than
  request/response.
- **Cost per extraction.** Opus 5 with high effort on a full recipe is a real per-call cost, but it
  lands on the key of whoever ran it, not on the deployer. Prompt caching helps on repair retries.
- **Keys in `localStorage`.** Convenient and appropriate for a prototype, but it means the key
  survives until explicitly forgotten and is readable by any script running on the page. The
  "Forget" control exists for shared machines. Not a pattern to carry into production untouched.
- **Extraction quality is the whole project.** The failure mode to watch is a *plausible* graph with
  a subtly wrong dependency — worse than an obviously broken one, because validation can't catch it.
  The golden fixture exists to make regressions visible.
- **Inference widens that surface.** Q1 and Q2 mean the app now invents steps and estimates times
  the recipe never stated. That's where most of the parallelism value comes from, but a wrong
  inferred step is indistinguishable from a real one to a cook who hasn't read the source. The `~`
  marker and the inferred-step styling are the mitigation; honest estimates matter more than
  confident ones.
- **Mermaid layout on large graphs.** Measured at M2: the 39-node minestrone graph lays out to a
  4327px-wide SVG. It is legible and pan/zoom handles it, but `LR` grows wide fast, and a denser
  recipe plus nested subgraphs may push the custom layout renderer earlier than planned. Switching
  to `TB` is a one-line option change if that helps.

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

**Resolved in M2** — Q8 component fixture coverage: `fixtures/garlic-butter-pasta.*` adds a recipe
with an explicitly headed "For the sauce:" section, and the subgraph render path is verified in the
browser.

**Resolved** — Q9: extraction verified working by hand against the live API (2026-08-26), using
Opus 5 at high effort.

**Currently open:**

- **Q10 — Does Sonnet 5 at medium effort hold up?** The model was moved down from Opus 5 / high for
  cost after Q9 was verified, so the verification does not carry over. The things most likely to
  degrade are the judgement calls rather than the mechanics: whether prep steps get split at the
  right granularity, whether active and passive time are separated correctly, and whether
  non-obvious dependencies are spotted. Worth one comparison run against the minestrone fixture.

## 12. Milestones

- **M0 — Scaffolding.** ✅ Next.js app, hello-world page, Vercel CLI installed.
- **M1 — Schema + validation.** ✅ Zod schemas (`lib/schema/recipe-graph.ts`), hand-authored
  minestrone fixture (`fixtures/`), validation rules (`lib/graph/validate.ts`), 25 unit tests.
  No LLM involved. The fixture is 21 ingredients / 18 steps / 42 edges, matching the reference
  diagram, and validates clean with zero warnings.
- **M2 — Topology + Mermaid renderer.** ✅ `lib/graph/topology.ts` (CPM scheduling, critical path,
  slack, layers, station and component grouping), `lib/render/mermaid.ts`, `components/MermaidDiagram.tsx`,
  and a fixture-preview page with a recipe switcher, timing summary and legend. 58 unit tests.
  Both fixtures verified rendering in the browser, including the component subgraph path.
  No API calls spent.
- **M3 — Extraction (paste).** ✅ *Built, not yet run against the live API.*
  `lib/extraction/prompt.ts` (cached system prompt with the extraction rules and a worked example),
  `lib/extraction/extract.ts` (streamed Opus 5 call, structured outputs, bounded repair loop),
  `app/api/extract/route.ts`, and a paste-and-extract UI. 68 unit tests, repair loop covered against
  a stubbed client. Users supply their own API key on the page (§8). **Still outstanding: a real
  extraction run, and a comparison against the golden fixture.**
- **M4 — URL ingest.** ✅ `lib/extraction/fetch-page.ts` (SSRF guard, JSON-LD extraction with
  `HowToStep`/`HowToSection` handling, HTML fallback, specific failure messages), wired into the
  route and a paste/URL tab switcher. 98 unit tests. The JSON-LD path is verified against the live
  reference URL.
- **M5 — Polish + deploy.** ✅ `lib/history.ts` + `components/HistoryBar.tsx` — the last 10
  extractions kept in the browser as **graphs**, so reopening one re-renders locally with no API
  call and no cost. Entries are re-validated on load and silently dropped if an older version of
  the app wrote a shape that no longer parses. Quota failures degrade by dropping the oldest rather
  than losing the write. Plus a README and the production deploy, live at
  https://recipe-flow-alpha.vercel.app. 111 unit tests.

  The first deploy failed at `npm install`: `@rolldown/binding-darwin-arm64` — added earlier to work
  around an npm bug that stopped vitest 4 finding its native binding locally — declares
  `os: darwin`, so it broke Vercel's Linux builders outright. Fixed by moving to vitest 3, which
  builds on vite/esbuild rather than rolldown, removing the need for the workaround. `package.json`
  now contains nothing platform-specific.

Storing the graph rather than the rendering is what makes restore free — and it is the same property
that would make graph editing (Q5) possible later, since everything downstream of extraction is a
pure function of the graph.

Ordering M2 before M3 is deliberate: it makes the rendering path debuggable against a known-good
graph, so when extraction lands, any bad diagram is unambiguously an extraction problem.

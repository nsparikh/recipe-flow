# Recipe Flow

**Live at [recipe-flow-alpha.vercel.app](https://recipe-flow-alpha.vercel.app)** — bring your own
Anthropic API key.

A recipe is a linear document describing a process that isn't linear. Standard recipes bury the
dependency structure — what blocks what, what can run in parallel, which waits you could be cooking
through — inside prose ordering.

Recipe Flow takes a recipe, recovers its dependency graph, and draws it as a flowchart you can cook
from.

For the minestrone it ships with, that's **62 minutes start to finish against 82 done one step at a
time** — twenty minutes recovered purely by reordering work the recipe already described. Peeling
the carrots turns out to sit on the critical path; grating the Parmesan has 59 minutes of slack.

## Using it

Paste a recipe, or give it a URL. You'll need your own [Anthropic API
key](https://console.anthropic.com/settings/keys) — extraction runs on Claude, and usage is billed
to your account. The key is kept in your browser and sent with each request so the server can make
the call; it is never logged or stored server-side.

Recently extracted recipes are kept in your browser and reopen without another API call.

## Running locally

```bash
npm install
npm run dev
```

No environment variables are needed — the API key is entered in the app.

```bash
npm test          # unit tests
npm run build     # production build
```

## How it works

Five stages, each independently testable:

```
recipe text ──┐
              ├─> [ extract ] ─> RecipeGraph ─> [ validate ] ─> [ derive topology ] ─> [ render ]
recipe URL ───┘        ^                             │
                       └────── errors (repair) ──────┘
```

- **Ingest** — pasted text, or a URL. URLs try `schema.org/Recipe` JSON-LD first and fall back to
  stripped page text.
- **Extract** — one Claude call with structured outputs turns prose into a graph. Ingredient-line
  prep ("1 onion, chopped") becomes its own step, since that's real work you can start early.
- **Validate** — structural errors feed back to the model for up to two repair attempts. Semantic
  warnings are surfaced but never block.
- **Derive topology** — critical-path scheduling, slack, layers of independent work, station and
  component grouping. Renderer-agnostic by design.
- **Render** — Mermaid today; the topology layer exists so swimlane and cook-along views can be
  added without touching anything upstream.

Times the recipe states are shown bare (`8m`); times the model estimated are marked with a tilde
(`~3m`). Steps inferred from an ingredient line are drawn faded.

[PLAN.md](PLAN.md) is the working design document — architecture, data model, decisions and their
reasoning, known limitations, and open questions.

## Status

Proof of concept. Not production-ready, and a few things are deliberately unfinished — see
§10 and §11 of [PLAN.md](PLAN.md), particularly the DNS-rebinding gap in the URL fetcher and the
fact that scheduling assumes unlimited hands.

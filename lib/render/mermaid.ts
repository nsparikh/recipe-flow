import type { Edge, IngredientNode, StepNode } from "../schema/recipe-graph";
import type { RecipeTopology } from "../graph/topology";

/**
 * Renders a RecipeTopology as Mermaid `flowchart` source.
 *
 * Pure and DOM-free, so it is snapshot-testable without a browser. This is one consumer of the
 * topology layer; swimlane and cook-along views will be siblings, not replacements.
 */

export interface MermaidOptions {
  /** `LR` reads best for recipes — ingredients on the left, the dish on the right. */
  direction?: "LR" | "TB";
}

export function renderMermaid(topology: RecipeTopology, options: MermaidOptions = {}): string {
  const { graph, flags } = topology;
  const direction = options.direction ?? "LR";
  const lines: string[] = [`flowchart ${direction}`];

  // --- Node declarations, grouped into component subgraphs -------------------

  const declared = new Set<string>();
  const declare = (id: string): string | null => {
    if (declared.has(id)) return null;
    declared.add(id);
    const ingredient = graph.ingredients.find((i) => i.id === id);
    if (ingredient) return declareIngredient(ingredient);
    const step = graph.steps.find((s) => s.id === id);
    return step ? declareStep(step) : null;
  };

  // Components render as nested subgraphs; `parentId` gives the nesting.
  const emitComponent = (componentId: string, indent: string): void => {
    const component = topology.byComponent.find((c) => c.id === componentId);
    if (!component) return;
    lines.push(`${indent}subgraph ${componentId}["${escapeLabel(component.title)}"]`);
    for (const childId of component.childComponentIds) emitComponent(childId, `${indent}  `);
    for (const nodeId of component.nodeIds) {
      const decl = declare(nodeId);
      if (decl) lines.push(`${indent}  ${decl}`);
    }
    lines.push(`${indent}end`);
  };

  for (const rootId of topology.rootComponentIds) emitComponent(rootId, "  ");

  // Anything not claimed by a component sits at the top level.
  for (const node of [...graph.ingredients, ...graph.steps]) {
    const decl = declare(node.id);
    if (decl) lines.push(`  ${decl}`);
  }

  // --- Edges -----------------------------------------------------------------

  lines.push("");
  for (const edge of graph.edges) lines.push(`  ${renderEdge(edge)}`);

  // --- Styling ---------------------------------------------------------------

  lines.push("");
  lines.push("  classDef ingredient fill:#f4f1ea,stroke:#c8bfa8,color:#3b352a");
  lines.push("  classDef passive fill:#eef3f8,stroke:#9fb8ce,color:#22384a");
  lines.push("  classDef terminal fill:#e9f4ec,stroke:#8fbf9f,color:#204731");
  lines.push("  classDef critical stroke-width:2.5px");
  // Dashes are reserved for `optional`, so inferred is marked by transparency instead.
  // A node can be both — p8 "grate Parmesan" in the minestrone fixture is.
  lines.push("  classDef optional stroke-dasharray:4 4");
  lines.push("  classDef inferred opacity:0.72");

  const classed = (ids: string[], className: string) => {
    if (ids.length > 0) lines.push(`  class ${ids.join(",")} ${className}`);
  };

  classed(graph.ingredients.map((i) => i.id), "ingredient");
  classed(graph.steps.filter((s) => flags[s.id].isPassive).map((s) => s.id), "passive");
  classed(graph.steps.filter((s) => flags[s.id].isTerminal).map((s) => s.id), "terminal");
  classed(graph.steps.filter((s) => flags[s.id].onCriticalPath).map((s) => s.id), "critical");
  classed(
    [...graph.ingredients, ...graph.steps].filter((n) => flags[n.id].isOptional).map((n) => n.id),
    "optional",
  );
  classed(graph.steps.filter((s) => flags[s.id].isInferred).map((s) => s.id), "inferred");

  return lines.join("\n");
}

function declareIngredient(node: IngredientNode): string {
  const parts = [node.name];
  if (node.quantity) parts.push(node.quantity);
  return `${node.id}(["${parts.map(escapeLabel).join("<br/>")}"])`;
}

function declareStep(step: StepNode): string {
  const parts = [step.label];
  const time = formatTime(step);
  if (time) parts.push(time);
  if (step.details) parts.push(step.details);
  return `${step.id}["${parts.map(escapeLabel).join("<br/>")}"]`;
}

/**
 * Formats a step's timing, marking estimates with `~`.
 *
 * This is the convention already used in the reference minestrone diagram: inferred prep reads
 * `~3m` while a recipe-stated duration reads `8m`. Zero active time is omitted rather than
 * rendered as `0m`, so a covered simmer reads `15m wait`.
 */
export function formatTime(step: StepNode): string {
  const segments: string[] = [];
  const active = step.activeTimeMin;
  const passive = step.passiveTimeMin;

  if (active !== undefined && active > 0) {
    segments.push(`${step.activeTimeEstimated ? "~" : ""}${active}m`);
  }
  if (passive !== undefined && passive > 0) {
    segments.push(`${step.passiveTimeEstimated ? "~" : ""}${passive}m wait`);
  }
  return segments.join(" + ");
}

function renderEdge(edge: Edge): string {
  const text = edge.label ?? edge.quantity;
  return text
    ? `${edge.from} -->|"${escapeLabel(text)}"| ${edge.to}`
    : `${edge.from} --> ${edge.to}`;
}

/**
 * Mermaid reads `#` as the start of an entity code and `"` as a string terminator, so both have to
 * be encoded. `<` and `>` are encoded too — the only markup we want in a label is the `<br/>`
 * separators this module inserts itself, after escaping.
 */
export function escapeLabel(text: string): string {
  return text
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;");
}

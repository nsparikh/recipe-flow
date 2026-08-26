import type { RecipeGraph } from "../schema/recipe-graph";

/**
 * Structural and semantic validation of a RecipeGraph.
 *
 * Errors are structural defects that make the graph unrenderable or incoherent. They feed the
 * extraction repair loop — the codes and messages are written to be useful to a model reading them.
 *
 * Warnings are semantic smells that a human should see but that must never block rendering.
 * A recipe can legitimately trip several of them.
 */

export type ValidationErrorCode =
  | "DUPLICATE_NODE_ID"
  | "DUPLICATE_COMPONENT_ID"
  | "UNKNOWN_EDGE_ENDPOINT"
  | "EDGE_INTO_INGREDIENT"
  | "DUPLICATE_EDGE"
  | "CYCLE"
  | "UNKNOWN_COMPONENT_REF"
  | "UNKNOWN_COMPONENT_PARENT"
  | "COMPONENT_PARENT_CYCLE"
  | "NO_TERMINALS"
  | "UNKNOWN_TERMINAL"
  | "TERMINAL_HAS_OUTGOING"
  | "ORPHAN_STEP";

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: string[];
}

export function validateRecipeGraph(graph: RecipeGraph): ValidationResult {
  const errors: ValidationError[] = [];
  // Warnings the extraction step raised itself pass straight through.
  const warnings: string[] = [...graph.warnings];

  const ingredientIds = new Set(graph.ingredients.map((i) => i.id));
  const stepIds = new Set(graph.steps.map((s) => s.id));
  const componentIds = new Set(graph.components.map((c) => c.id));

  // --- IDs ------------------------------------------------------------------

  const seenNodeIds = new Set<string>();
  for (const id of [...graph.ingredients, ...graph.steps].map((n) => n.id)) {
    if (seenNodeIds.has(id)) {
      errors.push({ code: "DUPLICATE_NODE_ID", message: `Node id "${id}" is used more than once.`, nodeId: id });
    }
    seenNodeIds.add(id);
  }

  const seenComponentIds = new Set<string>();
  for (const c of graph.components) {
    if (seenComponentIds.has(c.id)) {
      errors.push({ code: "DUPLICATE_COMPONENT_ID", message: `Component id "${c.id}" is used more than once.`, nodeId: c.id });
    }
    seenComponentIds.add(c.id);
  }

  // --- Components -----------------------------------------------------------

  for (const node of [...graph.ingredients, ...graph.steps]) {
    if (node.componentId && !componentIds.has(node.componentId)) {
      errors.push({
        code: "UNKNOWN_COMPONENT_REF",
        message: `Node "${node.id}" references component "${node.componentId}", which does not exist.`,
        nodeId: node.id,
      });
    }
  }

  for (const c of graph.components) {
    if (c.parentId && !componentIds.has(c.parentId)) {
      errors.push({
        code: "UNKNOWN_COMPONENT_PARENT",
        message: `Component "${c.id}" references parent "${c.parentId}", which does not exist.`,
        nodeId: c.id,
      });
    }
  }

  const parentOf = new Map(graph.components.map((c) => [c.id, c.parentId]));
  for (const c of graph.components) {
    const seen = new Set<string>([c.id]);
    let cursor = parentOf.get(c.id);
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push({ code: "COMPONENT_PARENT_CYCLE", message: `Component "${c.id}" is part of a parent cycle.`, nodeId: c.id });
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  // --- Edges ----------------------------------------------------------------

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const seenEdges = new Set<string>();

  for (const edge of graph.edges) {
    const key = `${edge.from}->${edge.to}`;
    if (seenEdges.has(key)) {
      errors.push({ code: "DUPLICATE_EDGE", message: `Duplicate edge ${edge.from} -> ${edge.to}.`, edge });
    }
    seenEdges.add(key);

    const fromExists = ingredientIds.has(edge.from) || stepIds.has(edge.from);
    const toExists = ingredientIds.has(edge.to) || stepIds.has(edge.to);

    if (!fromExists) {
      errors.push({ code: "UNKNOWN_EDGE_ENDPOINT", message: `Edge source "${edge.from}" does not exist.`, edge });
    }
    if (!toExists) {
      errors.push({ code: "UNKNOWN_EDGE_ENDPOINT", message: `Edge target "${edge.to}" does not exist.`, edge });
    }
    // Ingredients are always sources. Nothing flows into one.
    if (ingredientIds.has(edge.to)) {
      errors.push({
        code: "EDGE_INTO_INGREDIENT",
        message: `Edge ${edge.from} -> ${edge.to} points into an ingredient. Ingredients can only be sources.`,
        edge,
      });
    }

    if (fromExists && toExists) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from)!.push(edge.to);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to)!.push(edge.from);
    }
  }

  // --- Acyclicity -----------------------------------------------------------

  const cycle = findCycle([...seenNodeIds], outgoing);
  if (cycle) {
    errors.push({ code: "CYCLE", message: `The graph contains a cycle: ${cycle.join(" -> ")}. A recipe must be a DAG.` });
  }

  // --- Terminals ------------------------------------------------------------

  if (graph.terminalStepIds.length === 0) {
    errors.push({ code: "NO_TERMINALS", message: "terminalStepIds is empty. A recipe must have at least one final step." });
  }

  for (const id of graph.terminalStepIds) {
    if (!stepIds.has(id)) {
      errors.push({ code: "UNKNOWN_TERMINAL", message: `terminalStepIds references "${id}", which is not a step.`, nodeId: id });
      continue;
    }
    if ((outgoing.get(id) ?? []).length > 0) {
      errors.push({
        code: "TERMINAL_HAS_OUTGOING",
        message: `Step "${id}" is marked terminal but has outgoing edges.`,
        nodeId: id,
      });
    }
  }

  // --- Steps ----------------------------------------------------------------

  for (const step of graph.steps) {
    const hasIn = (incoming.get(step.id) ?? []).length > 0;
    const hasOut = (outgoing.get(step.id) ?? []).length > 0;
    if (!hasIn && !hasOut) {
      errors.push({ code: "ORPHAN_STEP", message: `Step "${step.id}" has no edges at all.`, nodeId: step.id });
    }
  }

  // --- Warnings -------------------------------------------------------------

  for (const ing of graph.ingredients) {
    const edgeCount = (outgoing.get(ing.id) ?? []).length;
    if (edgeCount === 0) {
      warnings.push(`Ingredient "${ing.name}" is listed but never used in any step.`);
      continue;
    }
    // "divided" is the recipe's own signal that an ingredient is split across steps.
    // A single outgoing edge means the split was probably missed.
    const saysDivided = `${ing.quantity ?? ""} ${ing.note ?? ""}`.toLowerCase().includes("divided");
    if (saysDivided && edgeCount === 1) {
      warnings.push(`Ingredient "${ing.name}" is marked "divided" but is only used in one step.`);
    }
  }

  if (graph.terminalStepIds.length > 1) {
    warnings.push(
      `Recipe has ${graph.terminalStepIds.length} terminal steps. This is legitimate for components served together, but may indicate a missing final assembly step.`,
    );
  }

  // Steps that can never reach a finished dish are dead-end work.
  const reachesTerminal = reverseReachable(graph.terminalStepIds.filter((id) => stepIds.has(id)), incoming);
  for (const step of graph.steps) {
    if (!reachesTerminal.has(step.id)) {
      warnings.push(`Step "${step.label}" (${step.id}) has no path to any terminal step.`);
    }
  }

  for (const component of graph.components) {
    const memberIds = new Set(
      [...graph.ingredients, ...graph.steps].filter((n) => n.componentId === component.id).map((n) => n.id),
    );
    if (memberIds.size === 0) {
      warnings.push(`Component "${component.title}" has no nodes assigned to it.`);
      continue;
    }
    const connectsOut = graph.edges.some(
      (e) => (memberIds.has(e.from) && !memberIds.has(e.to)) || (!memberIds.has(e.from) && memberIds.has(e.to)),
    );
    if (!connectsOut) {
      warnings.push(`Component "${component.title}" never connects to the rest of the recipe.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Depth-first cycle detection. Returns the offending path for a readable error message. */
function findCycle(nodeIds: string[], outgoing: Map<string, string[]>): string[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    colour.set(id, GREY);
    stack.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const c = colour.get(next) ?? WHITE;
      if (c === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(id, BLACK);
    return null;
  }

  for (const id of nodeIds) {
    if ((colour.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Every node that can reach one of `targets` by following edges forward. */
function reverseReachable(targets: string[], incoming: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(targets);
  const queue = [...targets];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const prev of incoming.get(id) ?? []) {
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }
  return seen;
}

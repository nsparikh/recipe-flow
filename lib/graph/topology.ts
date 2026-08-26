import type { RecipeGraph, StepNode } from "../schema/recipe-graph";

/**
 * Derives layout-independent facts from a validated RecipeGraph.
 *
 * This is the renderer-agnostic seam: every view (Mermaid now, swimlanes and cook-along later)
 * consumes a RecipeTopology rather than the raw graph, so adding a view never touches extraction
 * or validation.
 *
 * PRECONDITION: the graph has passed `validateRecipeGraph` with no errors. In particular it must
 * be acyclic — `deriveTopology` throws rather than looping if it isn't.
 */

export interface StepTiming {
  /** Minutes from the start of cooking, assuming every independent step can run in parallel. */
  earliestStartMin: number;
  /** activeTimeMin + passiveTimeMin. */
  durationMin: number;
  earliestFinishMin: number;
  latestStartMin: number;
  latestFinishMin: number;
  /** How long this step can be delayed without delaying the dish. Zero means it's critical. */
  slackMin: number;
}

export interface NodeFlags {
  isTerminal: boolean;
  /** Mostly unattended: passive time exceeds active time. Derived, never stored on the node. */
  isPassive: boolean;
  isOptional: boolean;
  isInferred: boolean;
  onCriticalPath: boolean;
}

export interface ComponentTopology {
  id: string;
  title: string;
  parentId?: string;
  childComponentIds: string[];
  nodeIds: string[];
  /** Steps where this sub-recipe is finished — its output leaves the component. Derived. */
  terminalStepIds: string[];
}

export interface RecipeTopology {
  graph: RecipeGraph;
  /** Topological order over all nodes, ingredients included. */
  order: string[];
  /** Longest-path layer per node. Nodes sharing a depth are guaranteed mutually independent. */
  depth: Record<string, number>;
  /** Keyed by step id. Ingredients have no timing. */
  timing: Record<string, StepTiming>;
  flags: Record<string, NodeFlags>;
  /** Ordered chain of steps that determines the total time. */
  criticalPath: string[];
  /** Total hands-on minutes. */
  totalActiveMin: number;
  totalPassiveMin: number;
  /** Wall-clock minutes with perfect parallelism — the critical path length. */
  projectDurationMin: number;
  /** Wall-clock minutes doing every step one after another. The contrast is the whole point. */
  sequentialDurationMin: number;
  /** Steps grouped into layers of mutually independent work. */
  parallelGroups: string[][];
  byStation: Record<string, string[]>;
  byComponent: ComponentTopology[];
  rootComponentIds: string[];
}

export function deriveTopology(graph: RecipeGraph): RecipeTopology {
  const steps = new Map(graph.steps.map((s) => [s.id, s]));
  const allIds = [...graph.ingredients.map((i) => i.id), ...graph.steps.map((s) => s.id)];

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of allIds) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const edge of graph.edges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }

  const order = topologicalSort(allIds, outgoing, incoming);

  // --- Depth: longest path from any source ----------------------------------

  const depth: Record<string, number> = {};
  for (const id of order) {
    const preds = incoming.get(id) ?? [];
    depth[id] = preds.length === 0 ? 0 : Math.max(...preds.map((p) => depth[p] + 1));
  }

  // --- Forward pass: earliest possible schedule ------------------------------
  //
  // Ingredients are instantaneous sources, so only step predecessors push a step later.
  // This assumes unlimited hands — see the note in PLAN.md §6.

  const timing: Record<string, StepTiming> = {};
  for (const id of order) {
    const step = steps.get(id);
    if (!step) continue;

    const durationMin = stepDuration(step);
    const stepPreds = (incoming.get(id) ?? []).filter((p) => steps.has(p));
    const earliestStartMin = stepPreds.length === 0
      ? 0
      : Math.max(...stepPreds.map((p) => timing[p].earliestFinishMin));

    timing[id] = {
      earliestStartMin,
      durationMin,
      earliestFinishMin: earliestStartMin + durationMin,
      // Filled by the backward pass.
      latestStartMin: 0,
      latestFinishMin: 0,
      slackMin: 0,
    };
  }

  const projectDurationMin = graph.steps.length === 0
    ? 0
    : Math.max(...graph.steps.map((s) => timing[s.id].earliestFinishMin));

  // --- Backward pass: latest schedule and slack ------------------------------

  for (const id of [...order].reverse()) {
    if (!steps.has(id)) continue;
    const stepSuccs = (outgoing.get(id) ?? []).filter((s) => steps.has(s));
    const t = timing[id];
    t.latestFinishMin = stepSuccs.length === 0
      ? projectDurationMin
      : Math.min(...stepSuccs.map((s) => timing[s].latestStartMin));
    t.latestStartMin = t.latestFinishMin - t.durationMin;
    t.slackMin = t.latestStartMin - t.earliestStartMin;
  }

  const criticalPath = traceCriticalPath(graph.steps, timing, incoming);
  const onCriticalPath = new Set(criticalPath);

  // --- Flags ----------------------------------------------------------------

  const terminals = new Set(graph.terminalStepIds);
  const flags: Record<string, NodeFlags> = {};
  for (const ing of graph.ingredients) {
    flags[ing.id] = {
      isTerminal: false,
      isPassive: false,
      isOptional: ing.optional,
      isInferred: false,
      onCriticalPath: false,
    };
  }
  for (const step of graph.steps) {
    flags[step.id] = {
      isTerminal: terminals.has(step.id),
      isPassive: (step.passiveTimeMin ?? 0) > (step.activeTimeMin ?? 0),
      isOptional: step.optional,
      isInferred: step.inferred,
      onCriticalPath: onCriticalPath.has(step.id),
    };
  }

  // --- Groupings ------------------------------------------------------------

  const parallelGroups: string[][] = [];
  for (const step of graph.steps) {
    const layer = depth[step.id];
    (parallelGroups[layer] ??= []).push(step.id);
  }

  const byStation: Record<string, string[]> = {};
  for (const step of graph.steps) {
    const key = step.station ?? "unassigned";
    (byStation[key] ??= []).push(step.id);
  }

  const byComponent = graph.components.map((component) => {
    const memberIds = new Set(
      [...graph.ingredients, ...graph.steps]
        .filter((n) => n.componentId === component.id)
        .map((n) => n.id),
    );
    // A component's terminal is a step whose output leaves the component (or goes nowhere).
    const terminalStepIds = graph.steps
      .filter((s) => memberIds.has(s.id))
      .filter((s) => {
        const succs = outgoing.get(s.id) ?? [];
        return succs.length === 0 || succs.some((t) => !memberIds.has(t));
      })
      .map((s) => s.id);

    return {
      id: component.id,
      title: component.title,
      parentId: component.parentId,
      childComponentIds: graph.components.filter((c) => c.parentId === component.id).map((c) => c.id),
      nodeIds: [...memberIds],
      terminalStepIds,
    };
  });

  return {
    graph,
    order,
    depth,
    timing,
    flags,
    criticalPath,
    totalActiveMin: sum(graph.steps.map((s) => s.activeTimeMin ?? 0)),
    totalPassiveMin: sum(graph.steps.map((s) => s.passiveTimeMin ?? 0)),
    projectDurationMin,
    sequentialDurationMin: sum(graph.steps.map(stepDuration)),
    // `??= []` leaves holes when a depth layer contains only ingredients.
    parallelGroups: parallelGroups.filter((g) => g !== undefined && g.length > 0),
    byStation,
    byComponent,
    rootComponentIds: graph.components.filter((c) => !c.parentId).map((c) => c.id),
  };
}

function stepDuration(step: StepNode): number {
  return (step.activeTimeMin ?? 0) + (step.passiveTimeMin ?? 0);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Kahn's algorithm. Throws on a cycle — callers must validate first. */
function topologicalSort(
  allIds: string[],
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>,
): string[] {
  const remaining = new Map(allIds.map((id) => [id, (incoming.get(id) ?? []).length]));
  const queue = allIds.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  if (order.length !== allIds.length) {
    throw new Error("deriveTopology received a cyclic graph. Run validateRecipeGraph first.");
  }
  return order;
}

/**
 * Walks back from the last-finishing critical step through zero-slack predecessors,
 * producing the ordered chain that sets the total time.
 */
function traceCriticalPath(
  steps: StepNode[],
  timing: Record<string, StepTiming>,
  incoming: Map<string, string[]>,
): string[] {
  const critical = steps.filter((s) => timing[s.id].slackMin === 0);
  if (critical.length === 0) return [];

  let cursor = critical.reduce((best, s) =>
    timing[s.id].earliestFinishMin > timing[best.id].earliestFinishMin ? s : best,
  ).id;

  const stepIds = new Set(steps.map((s) => s.id));
  const path = [cursor];
  const guard = new Set([cursor]);

  while (true) {
    const prev = (incoming.get(cursor) ?? [])
      .filter((p) => stepIds.has(p) && !guard.has(p))
      .find(
        (p) =>
          timing[p].slackMin === 0 &&
          timing[p].earliestFinishMin === timing[cursor].earliestStartMin,
      );
    if (!prev) break;
    path.push(prev);
    guard.add(prev);
    cursor = prev;
  }

  return path.reverse();
}

import type { RecipeGraph } from "./schema/recipe-graph";
import { validateRecipeGraph } from "./graph/validate";
import { deriveTopology } from "./graph/topology";
import { renderMermaid } from "./render/mermaid";

/**
 * Everything the UI needs to display one recipe.
 *
 * Fixtures build this on the server; extractions build it in the API route. Both paths produce the
 * same shape, so the display component never knows or cares where a graph came from.
 */
export interface RecipeView {
  title: string;
  servings?: string;
  mermaid: string;
  warnings: string[];
  summary: {
    projectDurationMin: number;
    sequentialDurationMin: number;
    totalActiveMin: number;
  };
}

export function buildRecipeView(graph: RecipeGraph): RecipeView {
  const validation = validateRecipeGraph(graph);
  const topology = deriveTopology(graph);

  return {
    title: graph.title,
    servings: graph.servings,
    mermaid: renderMermaid(topology),
    warnings: validation.warnings,
    summary: {
      projectDurationMin: topology.projectDurationMin,
      sequentialDurationMin: topology.sequentialDurationMin,
      totalActiveMin: topology.totalActiveMin,
    },
  };
}

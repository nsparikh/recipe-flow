import { RecipeGraphSchema, type RecipeGraph } from "./schema/recipe-graph";

/**
 * Recently extracted recipes, kept in this browser.
 *
 * The stored value is the **graph**, never the rendered Mermaid — a graph can be re-rendered,
 * re-scheduled, and (later) edited, whereas rendered output is a dead end. Restoring is therefore
 * a pure client-side rebuild through `buildRecipeView`, with no API call and no cost.
 */

export const HISTORY_STORAGE_KEY = "recipe-flow:history";
export const HISTORY_LIMIT = 10;

export interface HistoryEntry {
  id: string;
  title: string;
  savedAt: number;
  sourceUrl?: string;
  graph: RecipeGraph;
}

/** Same recipe extracted twice replaces the earlier entry rather than filling the list. */
function identityOf(graph: RecipeGraph): string {
  return graph.sourceUrl?.trim() || graph.title.trim().toLowerCase();
}

export function loadHistory(): HistoryEntry[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Entries were written by an older version of the app as easily as this one, so each is
    // re-validated and anything that no longer fits the schema is dropped rather than crashing.
    return parsed.flatMap((entry): HistoryEntry[] => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      const graph = RecipeGraphSchema.safeParse(candidate.graph);
      if (!graph.success) return [];
      return [
        {
          id: String(candidate.id ?? identityOf(graph.data)),
          title: String(candidate.title ?? graph.data.title),
          savedAt: Number(candidate.savedAt) || 0,
          sourceUrl: typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : undefined,
          graph: graph.data,
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Returns the new list so callers can set state from it directly. */
export function rememberRecipe(graph: RecipeGraph, savedAt: number): HistoryEntry[] {
  const id = identityOf(graph);
  const entry: HistoryEntry = {
    id,
    title: graph.title,
    savedAt,
    sourceUrl: graph.sourceUrl,
    graph,
  };

  const next = [entry, ...loadHistory().filter((e) => e.id !== id)].slice(0, HISTORY_LIMIT);
  persist(next);
  return next;
}

export function forgetRecipe(id: string): HistoryEntry[] {
  const next = loadHistory().filter((entry) => entry.id !== id);
  persist(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  try {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Ignore.
  }
  return [];
}

/**
 * Graphs are a few tens of kilobytes each, so the quota is reachable. On failure, drop the oldest
 * entries and retry rather than losing the write entirely.
 */
function persist(entries: HistoryEntry[]): void {
  let candidates = entries;
  while (candidates.length > 0) {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(candidates));
      return;
    } catch {
      candidates = candidates.slice(0, -1);
    }
  }
  try {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Nothing left to try.
  }
}

/** Compact relative time for the history chips. */
export function formatSavedAt(savedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

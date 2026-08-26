import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RecipeGraphSchema, type RecipeGraph } from "../schema/recipe-graph";
import {
  HISTORY_LIMIT,
  HISTORY_STORAGE_KEY,
  clearHistory,
  forgetRecipe,
  formatSavedAt,
  loadHistory,
  rememberRecipe,
} from "../history";

const raw = JSON.parse(readFileSync("fixtures/minestrone.graph.json", "utf8"));
/** The fixture carries a sourceUrl, which is the dedup identity — dropped unless a test wants it. */
function graph(overrides: Partial<RecipeGraph> = {}): RecipeGraph {
  const base = JSON.parse(JSON.stringify(raw));
  delete base.sourceUrl;
  return RecipeGraphSchema.parse({ ...base, ...overrides });
}

/** Minimal localStorage stand-in — the history module only needs these three methods. */
class MemoryStorage {
  private store = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

describe("remembering recipes", () => {
  it("stores the graph, not a rendering", () => {
    rememberRecipe(graph(), 1000);
    const stored = JSON.parse(storage.getItem(HISTORY_STORAGE_KEY)!);
    expect(stored[0].graph.steps).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain("flowchart");
  });

  it("returns entries newest first", () => {
    rememberRecipe(graph({ title: "First" }), 1000);
    rememberRecipe(graph({ title: "Second" }), 2000);
    expect(loadHistory().map((e) => e.title)).toEqual(["Second", "First"]);
  });

  it("replaces an earlier entry for the same recipe rather than duplicating", () => {
    rememberRecipe(graph({ title: "Minestrone" }), 1000);
    const after = rememberRecipe(graph({ title: "Minestrone" }), 5000);
    expect(after).toHaveLength(1);
    expect(after[0].savedAt).toBe(5000);
  });

  it("treats the source URL as the identity when present", () => {
    rememberRecipe(graph({ title: "Soup", sourceUrl: "https://example.com/a" }), 1000);
    rememberRecipe(graph({ title: "Renamed Soup", sourceUrl: "https://example.com/a" }), 2000);
    const entries = loadHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Renamed Soup");
  });

  it("caps the list at the limit, dropping the oldest", () => {
    for (let i = 0; i < HISTORY_LIMIT + 4; i++) {
      rememberRecipe(graph({ title: `Recipe ${i}` }), 1000 + i);
    }
    const entries = loadHistory();
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0].title).toBe(`Recipe ${HISTORY_LIMIT + 3}`);
    expect(entries.map((e) => e.title)).not.toContain("Recipe 0");
  });
});

describe("removing", () => {
  it("forgets one entry and keeps the rest", () => {
    rememberRecipe(graph({ title: "Keep" }), 1000);
    rememberRecipe(graph({ title: "Drop" }), 2000);
    const after = forgetRecipe("drop");
    expect(after.map((e) => e.title)).toEqual(["Keep"]);
  });

  it("clears everything", () => {
    rememberRecipe(graph(), 1000);
    expect(clearHistory()).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });
});

describe("resilience", () => {
  it("returns empty when nothing is stored", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("survives corrupted JSON", () => {
    storage.setItem(HISTORY_STORAGE_KEY, "{not json");
    expect(loadHistory()).toEqual([]);
  });

  it("drops entries whose graph no longer matches the schema", () => {
    // An entry written by an older version of the app must not crash the page.
    storage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([
        { id: "stale", title: "Stale", savedAt: 1, graph: { title: "missing everything else" } },
        { id: "good", title: "Good", savedAt: 2, graph: graph() },
      ]),
    );
    const entries = loadHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Good");
  });

  it("does not throw when storage is unavailable", () => {
    storage.failWrites = true;
    expect(() => rememberRecipe(graph(), 1000)).not.toThrow();
  });
});

describe("formatSavedAt", () => {
  const minute = 60_000;
  it("describes recent saves in relative terms", () => {
    expect(formatSavedAt(1_000_000, 1_000_000)).toBe("just now");
    expect(formatSavedAt(1_000_000, 1_000_000 + 5 * minute)).toBe("5m ago");
    expect(formatSavedAt(1_000_000, 1_000_000 + 3 * 60 * minute)).toBe("3h ago");
    expect(formatSavedAt(1_000_000, 1_000_000 + 24 * 60 * minute)).toBe("yesterday");
    expect(formatSavedAt(1_000_000, 1_000_000 + 5 * 24 * 60 * minute)).toBe("5d ago");
  });

  it("never reports a negative age from clock skew", () => {
    expect(formatSavedAt(2_000_000, 1_000_000)).toBe("just now");
  });
});

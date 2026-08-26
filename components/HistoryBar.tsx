"use client";

import { formatSavedAt, type HistoryEntry } from "../lib/history";

/**
 * Recently extracted recipes. Restoring one re-renders from the stored graph in the browser —
 * no API call, so revisiting a recipe costs nothing.
 */
export function HistoryBar({
  entries,
  activeId,
  now,
  onRestore,
  onForget,
  onClear,
}: {
  entries: HistoryEntry[];
  activeId: string | null;
  /** Passed in rather than read here, so the server and client render the same markup. */
  now: number | null;
  onRestore: (entry: HistoryEntry) => void;
  onForget: (id: string) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) return null;

  return (
    <section className="history">
      <div className="history-head">
        <h2>Recent</h2>
        <button type="button" className="link" onClick={onClear}>
          Clear all
        </button>
      </div>

      <ul className="history-list">
        {entries.map((entry) => (
          <li key={entry.id} className={entry.id === activeId ? "active" : ""}>
            <button type="button" className="history-open" onClick={() => onRestore(entry)}>
              <span className="history-title">{entry.title}</span>
              {now !== null && <span className="history-time">{formatSavedAt(entry.savedAt, now)}</span>}
            </button>
            <button
              type="button"
              className="history-forget"
              onClick={() => onForget(entry.id)}
              aria-label={`Forget ${entry.title}`}
              title="Forget this recipe"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

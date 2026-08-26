"use client";

import { useState } from "react";
import { looksLikeApiKey, maskApiKey } from "../lib/api-key";

/**
 * Collects the user's own Anthropic API key.
 *
 * The key is held in this browser and sent with each extraction request. It is worth being explicit
 * with the user about where it goes, so the panel says so rather than hiding it.
 */
export function ApiKeyPanel({
  apiKey,
  onSave,
  onForget,
}: {
  apiKey: string | null;
  onSave: (key: string) => void;
  onForget: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    const trimmed = draft.trim();
    if (!looksLikeApiKey(trimmed)) {
      setProblem('That does not look like an Anthropic API key — they start with "sk-ant-".');
      return;
    }
    setProblem(null);
    setDraft("");
    setEditing(false);
    onSave(trimmed);
  }

  if (apiKey && !editing) {
    return (
      <section className="key-panel saved">
        <div>
          <span className="key-label">API key</span>
          <code className="key-mask">{maskApiKey(apiKey)}</code>
        </div>
        <div className="key-actions">
          <button type="button" className="ghost" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button type="button" className="ghost" onClick={onForget}>
            Forget
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="key-panel">
      <label htmlFor="api-key">Your Anthropic API key</label>
      <p className="key-help">
        Extraction runs on Claude, so you need your own key from{" "}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer noopener">
          console.anthropic.com
        </a>
        . It is kept in this browser and sent with each request so the server can make the call on
        your behalf — it is never logged or stored on the server. Usage is billed to your account.
      </p>

      <div className="key-entry">
        <input
          id="api-key"
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
          placeholder="sk-ant-..."
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" className="primary" onClick={save} disabled={!draft.trim()}>
          Save
        </button>
        {editing && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setEditing(false);
              setDraft("");
              setProblem(null);
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {problem && <p className="key-problem">{problem}</p>}
    </section>
  );
}

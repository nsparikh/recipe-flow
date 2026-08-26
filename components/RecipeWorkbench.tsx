"use client";

import { useEffect, useState } from "react";
import { RecipeView } from "./RecipeView";
import { ApiKeyPanel } from "./ApiKeyPanel";
import { API_KEY_HEADER, forgetApiKey, loadApiKey, saveApiKey } from "../lib/api-key";
import type { RecipeView as RecipeViewModel } from "../lib/view-model";

export interface FixtureEntry {
  slug: string;
  name: string;
  /** The source text, so a fixture can be pushed into the box and re-extracted for comparison. */
  source: string;
  view: RecipeViewModel;
}

type Status =
  | { kind: "idle" }
  | { kind: "extracting" }
  | { kind: "failed"; message: string; details?: string[] };

export function RecipeWorkbench({ fixtures }: { fixtures: FixtureEntry[] }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [result, setResult] = useState<RecipeViewModel | null>(null);
  const [attempts, setAttempts] = useState<number | null>(null);
  const [activeFixture, setActiveFixture] = useState<string | null>(fixtures[0]?.slug ?? null);
  const [apiKey, setApiKey] = useState<string | null>(null);

  // localStorage is only available in the browser, so the key is read after mount rather than
  // during render — otherwise the server and client markup would disagree.
  useEffect(() => {
    setApiKey(loadApiKey());
  }, []);

  const shown = result ?? fixtures.find((f) => f.slug === activeFixture)?.view ?? null;
  const busy = status.kind === "extracting";
  const canExtract = Boolean(apiKey) && Boolean(text.trim()) && !busy;

  function handleSaveKey(key: string) {
    saveApiKey(key);
    setApiKey(key);
    if (status.kind === "failed") setStatus({ kind: "idle" });
  }

  function handleForgetKey() {
    forgetApiKey();
    setApiKey(null);
  }

  async function extract() {
    if (!canExtract || !apiKey) return;
    setStatus({ kind: "extracting" });
    setResult(null);
    setAttempts(null);

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [API_KEY_HEADER]: apiKey,
        },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setStatus({
          kind: "failed",
          message: payload.error ?? `Request failed with status ${response.status}.`,
          details: payload.errors?.map((e: { message: string }) => e.message),
        });
        return;
      }

      setResult(payload.view);
      setAttempts(payload.attempts ?? null);
      setActiveFixture(null);
      setStatus({ kind: "idle" });
    } catch (cause) {
      setStatus({
        kind: "failed",
        message: cause instanceof Error ? cause.message : "Something went wrong.",
      });
    }
  }

  function showFixture(slug: string) {
    setResult(null);
    setAttempts(null);
    setStatus({ kind: "idle" });
    setActiveFixture(slug);
  }

  return (
    <>
      <ApiKeyPanel apiKey={apiKey} onSave={handleSaveKey} onForget={handleForgetKey} />

      <section className="input-panel">
        <label htmlFor="recipe-text">Paste a recipe</label>
        <textarea
          id="recipe-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste the ingredients and instructions here…"
          rows={9}
          disabled={busy}
        />

        <div className="input-actions">
          <button type="button" className="primary" onClick={extract} disabled={!canExtract}>
            {busy ? "Extracting…" : "Build the flowchart"}
          </button>
          {!apiKey && text.trim() && <span className="hint">Add your API key above to extract.</span>}
          {text.trim() && !busy && (
            <button type="button" className="ghost" onClick={() => setText("")}>
              Clear
            </button>
          )}
          <span className="hint">
            Or load a sample:{" "}
            {fixtures.map((fixture, index) => (
              <span key={fixture.slug}>
                {index > 0 && ", "}
                <button type="button" className="link" onClick={() => setText(fixture.source)} disabled={busy}>
                  {fixture.name}
                </button>
              </span>
            ))}
          </span>
        </div>

        {busy && (
          <p className="progress">
            Reading the recipe and working out the dependencies. This usually takes under a minute.
          </p>
        )}

        {status.kind === "failed" && (
          <div className="error-panel">
            <strong>{status.message}</strong>
            {status.details && status.details.length > 0 && (
              <ul>
                {status.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="result-header">
        <nav className="fixture-switch">
          {fixtures.map((fixture) => (
            <button
              key={fixture.slug}
              type="button"
              className={!result && activeFixture === fixture.slug ? "active" : ""}
              onClick={() => showFixture(fixture.slug)}
            >
              {fixture.name}
            </button>
          ))}
          {result && <span className="badge">Extracted{attempts && attempts > 1 ? ` · ${attempts} attempts` : ""}</span>}
        </nav>
      </section>

      {shown && <RecipeView view={shown} />}
    </>
  );
}

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

type InputMode = "paste" | "url";

export function RecipeWorkbench({ fixtures }: { fixtures: FixtureEntry[] }) {
  const [mode, setMode] = useState<InputMode>("paste");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
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
  const hasInput = mode === "paste" ? Boolean(text.trim()) : Boolean(url.trim());
  const canExtract = Boolean(apiKey) && hasInput && !busy;

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
        body: JSON.stringify(mode === "paste" ? { text } : { url }),
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

  function switchMode(next: InputMode) {
    setMode(next);
    if (status.kind === "failed") setStatus({ kind: "idle" });
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
        <div className="mode-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "paste"}
            className={mode === "paste" ? "active" : ""}
            onClick={() => switchMode("paste")}
          >
            Paste text
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "url"}
            className={mode === "url" ? "active" : ""}
            onClick={() => switchMode("url")}
          >
            From a URL
          </button>
        </div>

        {mode === "paste" ? (
          <textarea
            id="recipe-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste the ingredients and instructions here…"
            rows={9}
            disabled={busy}
          />
        ) : (
          <>
            <input
              id="recipe-url"
              className="url-input"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && extract()}
              placeholder="https://example.com/best-minestrone"
              disabled={busy}
              spellCheck={false}
            />
            <p className="hint url-hint">
              Works best on sites that publish structured recipe data, which most do. Pages behind a
              paywall, or that need JavaScript to show the recipe, will need pasting instead.
            </p>
          </>
        )}

        <div className="input-actions">
          <button type="button" className="primary" onClick={extract} disabled={!canExtract}>
            {busy ? "Extracting…" : "Build the flowchart"}
          </button>
          {!apiKey && hasInput && <span className="hint">Add your API key above to extract.</span>}
          {hasInput && !busy && (
            <button
              type="button"
              className="ghost"
              onClick={() => (mode === "paste" ? setText("") : setUrl(""))}
            >
              Clear
            </button>
          )}
          {mode === "paste" && (
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
          )}
        </div>

        {busy && (
          <p className="progress">
            {mode === "url" ? "Fetching the page, then working" : "Working"} out the dependencies. This
            usually takes under a minute.
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

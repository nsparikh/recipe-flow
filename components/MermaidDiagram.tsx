"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Renders Mermaid source to SVG in the browser.
 *
 * Mermaid is large and touches `document`, so it is imported dynamically inside the effect rather
 * than at module scope — that keeps it out of the server bundle entirely.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderId = `mermaid-${useId().replace(/[:]/g, "")}`;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "strict",
          flowchart: { htmlLabels: true, curve: "basis", nodeSpacing: 40, rankSpacing: 70 },
        });
        const { svg } = await mermaid.render(renderId, source);
        if (!cancelled) {
          setSvg(svg);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setSvg(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, renderId]);

  if (error) {
    return (
      <div className="diagram-error">
        <strong>Mermaid failed to render this graph.</strong>
        <pre>{error}</pre>
      </div>
    );
  }

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <button type="button" onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))} aria-label="Zoom out">
          −
        </button>
        <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.15))} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          Reset
        </button>
      </div>

      <div className="diagram-scroll" ref={scrollRef}>
        {svg === null ? (
          <p className="diagram-loading">Rendering diagram…</p>
        ) : (
          <div
            className="diagram-canvas"
            style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
            // Mermaid output, sanitised by Mermaid's own strict security level.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </div>
  );
}

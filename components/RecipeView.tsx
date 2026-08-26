import { MermaidDiagram } from "./MermaidDiagram";
import type { RecipeView as RecipeViewModel } from "../lib/view-model";

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Displays one recipe. Identical whether the graph came from a fixture or from extraction. */
export function RecipeView({ view }: { view: RecipeViewModel }) {
  const saved = view.summary.sequentialDurationMin - view.summary.projectDurationMin;

  return (
    <>
      <div className="recipe-title">
        <h2>{view.title}</h2>
        {view.servings && <p className="servings">Serves {view.servings}</p>}
      </div>

      <section className="stats">
        <div className="stat">
          <span className="stat-value">{formatMinutes(view.summary.projectDurationMin)}</span>
          <span className="stat-label">start to finish</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatMinutes(view.summary.totalActiveMin)}</span>
          <span className="stat-label">hands-on</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatMinutes(view.summary.sequentialDurationMin)}</span>
          <span className="stat-label">if done one step at a time</span>
        </div>
        <div className="stat highlight">
          <span className="stat-value">{formatMinutes(saved)}</span>
          <span className="stat-label">saved by working in parallel</span>
        </div>
      </section>

      {view.warnings.length > 0 && (
        <section className="warnings">
          <h3>{view.warnings.length === 1 ? "1 warning" : `${view.warnings.length} warnings`}</h3>
          <ul>
            {view.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <MermaidDiagram source={view.mermaid} />

      <section className="legend">
        <h3>How to read this</h3>
        <ul>
          <li>
            <span className="swatch ingredient" /> Ingredients
          </li>
          <li>
            <span className="swatch passive" /> Mostly unattended — start something else
          </li>
          <li>
            <span className="swatch terminal" /> The finished dish
          </li>
          <li>
            <span className="swatch critical" /> On the critical path — a delay here delays dinner
          </li>
          <li>
            <span className="swatch optional" /> Optional
          </li>
          <li>
            <span className="swatch inferred" /> Inferred from an ingredient line, not written as a step
          </li>
          <li>
            <code>~</code> before a time means it is an estimate, not stated by the recipe
          </li>
        </ul>
      </section>
    </>
  );
}

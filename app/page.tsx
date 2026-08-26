import Link from "next/link";
import { MermaidDiagram } from "../components/MermaidDiagram";
import { deriveTopology } from "../lib/graph/topology";
import { validateRecipeGraph } from "../lib/graph/validate";
import { renderMermaid } from "../lib/render/mermaid";
import { FIXTURES, isFixtureSlug, loadFixture } from "../lib/fixtures";

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ recipe?: string }>;
}) {
  const { recipe } = await searchParams;
  const slug = isFixtureSlug(recipe) ? recipe : "minestrone";

  const graph = loadFixture(slug);
  const validation = validateRecipeGraph(graph);
  const topology = deriveTopology(graph);
  const source = renderMermaid(topology);

  const saved = topology.sequentialDurationMin - topology.projectDurationMin;

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Recipe Flow — fixture preview</p>
          <h1>{graph.title}</h1>
          {graph.servings && <p className="servings">Serves {graph.servings}</p>}
        </div>
        <nav className="fixture-switch">
          {FIXTURES.map((fixture) => (
            <Link
              key={fixture.slug}
              href={`/?recipe=${fixture.slug}`}
              className={fixture.slug === slug ? "active" : ""}
            >
              {fixture.name}
            </Link>
          ))}
        </nav>
      </header>

      <section className="stats">
        <div className="stat">
          <span className="stat-value">{formatMinutes(topology.projectDurationMin)}</span>
          <span className="stat-label">start to finish</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatMinutes(topology.totalActiveMin)}</span>
          <span className="stat-label">hands-on</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatMinutes(topology.sequentialDurationMin)}</span>
          <span className="stat-label">if done one step at a time</span>
        </div>
        <div className="stat highlight">
          <span className="stat-value">{formatMinutes(saved)}</span>
          <span className="stat-label">saved by working in parallel</span>
        </div>
      </section>

      {validation.warnings.length > 0 && (
        <section className="warnings">
          <h2>Warnings</h2>
          <ul>
            {validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <MermaidDiagram source={source} />

      <section className="legend">
        <h2>How to read this</h2>
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
    </main>
  );
}

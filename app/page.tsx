import { readFileSync } from "node:fs";
import path from "node:path";
import { RecipeWorkbench, type FixtureEntry } from "../components/RecipeWorkbench";
import { FIXTURES, loadFixture } from "../lib/fixtures";
import { buildRecipeView } from "../lib/view-model";

export default function Home() {
  const fixtures: FixtureEntry[] = FIXTURES.map((fixture) => ({
    slug: fixture.slug,
    name: fixture.name,
    source: readFileSync(path.join(process.cwd(), "fixtures", `${fixture.slug}.txt`), "utf8"),
    view: buildRecipeView(loadFixture(fixture.slug)),
  }));

  return (
    <main>
      <header className="page-header">
        <div>
          <h1>Recipe Flow</h1>
          <p className="tagline">
            A recipe is a linear document describing a process that isn&rsquo;t linear. This turns one
            back into the dependency graph it always was.
          </p>
        </div>
      </header>

      <RecipeWorkbench fixtures={fixtures} />
    </main>
  );
}

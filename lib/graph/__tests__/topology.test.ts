import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RecipeGraphSchema, type RecipeGraph } from "../../schema/recipe-graph";
import { deriveTopology } from "../topology";

const raw = JSON.parse(readFileSync("fixtures/minestrone.graph.json", "utf8"));
function fixture(): RecipeGraph {
  return RecipeGraphSchema.parse(JSON.parse(JSON.stringify(raw)));
}
const topo = () => deriveTopology(fixture());

describe("scheduling", () => {
  it("shows parallelism saving real time against doing it sequentially", () => {
    const t = topo();
    expect(t.sequentialDurationMin).toBe(82);
    expect(t.projectDurationMin).toBe(62);
    // The gap is the entire value proposition of the app.
    expect(t.sequentialDurationMin - t.projectDurationMin).toBe(20);
  });

  it("splits total time into active and passive", () => {
    const t = topo();
    expect(t.totalActiveMin).toBe(41);
    expect(t.totalPassiveMin).toBe(41);
    expect(t.totalActiveMin + t.totalPassiveMin).toBe(t.sequentialDurationMin);
  });

  it("schedules a step after its slowest step-predecessor finishes", () => {
    const t = topo();
    // s2 waits on s1 (1m), p1 (3m), p2 (4m) and p3 (2m) — the carrots gate it.
    expect(t.timing.s2.earliestStartMin).toBe(4);
    // Ingredients are instantaneous and never push a step later.
    expect(t.timing.p1.earliestStartMin).toBe(0);
  });

  it("carries passive time into the schedule", () => {
    const t = topo();
    // s6 simmers 15 unattended, so s7 cannot start until it is done.
    expect(t.timing.s6.earliestFinishMin).toBe(38);
    expect(t.timing.s7.earliestStartMin).toBe(38);
  });
});

describe("critical path", () => {
  it("runs from the longest prep through to the final step", () => {
    const t = topo();
    expect(t.criticalPath[0]).toBe("p2");
    expect(t.criticalPath.at(-1)).toBe("s10");
    expect(t.criticalPath).toEqual(["p2", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
  });

  it("is a contiguous chain whose durations sum to the total time", () => {
    const t = topo();
    const total = t.criticalPath.reduce((n, id) => n + t.timing[id].durationMin, 0);
    expect(total).toBe(t.projectDurationMin);
  });

  it("gives critical steps zero slack and non-critical steps room to move", () => {
    const t = topo();
    expect(t.timing.p2.slackMin).toBe(0);
    // Chopping celery is 2m of work gating a 4m dependency — 2m of room.
    expect(t.timing.p3.slackMin).toBe(2);
    // Grating Parmesan is only needed at the very end.
    expect(t.timing.p8.slackMin).toBe(59);
  });

  it("flags exactly the critical-path steps", () => {
    const t = topo();
    const flagged = t.graph.steps.filter((s) => t.flags[s.id].onCriticalPath).map((s) => s.id);
    expect(flagged.sort()).toEqual([...t.criticalPath].sort());
  });
});

describe("derived flags", () => {
  it("derives passive from passive time exceeding active time", () => {
    const t = topo();
    const passive = t.graph.steps.filter((s) => t.flags[s.id].isPassive).map((s) => s.id);
    expect(passive).toEqual(["s5", "s6", "s8"]);
  });

  it("derives terminal from terminalStepIds", () => {
    const t = topo();
    expect(t.flags.s10.isTerminal).toBe(true);
    expect(t.flags.s9.isTerminal).toBe(false);
  });

  it("carries optional and inferred through from the nodes", () => {
    const t = topo();
    expect(t.flags.p8.isOptional).toBe(true);
    expect(t.flags.p8.isInferred).toBe(true);
    expect(t.flags.s2.isInferred).toBe(false);
    expect(t.flags.ing_parm.isOptional).toBe(true);
  });
});

describe("groupings", () => {
  it("groups steps into layers of mutually independent work", () => {
    const t = topo();
    // Every prep step plus warming the oil can happen at once.
    expect(t.parallelGroups[0].sort()).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "s1"]);
    expect(t.parallelGroups.every((g) => g.length > 0)).toBe(true);
  });

  it("groups by station, ready for the swimlane view", () => {
    const t = topo();
    expect(Object.keys(t.byStation).sort()).toEqual(["counter", "sink", "stove"]);
    expect(t.byStation.stove).toContain("s6");
    expect(t.byStation.sink).toEqual(["p6"]);
  });

  it("produces no components for a recipe without sub-recipes", () => {
    const t = topo();
    expect(t.byComponent).toEqual([]);
    expect(t.rootComponentIds).toEqual([]);
  });
});

describe("preconditions", () => {
  it("throws on a cyclic graph rather than looping", () => {
    const g = fixture();
    g.edges.push({ from: "s8", to: "s5", type: "sequence" });
    expect(() => deriveTopology(g)).toThrow(/cyclic/i);
  });
});

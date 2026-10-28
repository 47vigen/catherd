import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetReadiness } from "../../src/services/backends.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { realEffects } from "../../src/services/run-effects.ts";
import { appendEvent, replayRun } from "../../src/services/run-events-store.ts";
import { treeDir } from "../../src/services/tree-path.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

describe("where a base run's roles work (plan 50 R10, Codex finding P1)", () => {
  it("starts an architect turn in the run's tree, never in the owner's checkout", async () => {
    const { run, repo } = branchRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({}).env);
    await appendEvent(run, { type: "run.started", ...startedFields, repo, base: "main" });
    const deps = fakeDeps();
    // the sim has no Claude CLI: the architect runs on a Codex rung here
    deps.view.roles.architect = { ...deps.view.roles.architect, rungs: ["codex:gpt-6-sol#high"] } as never;
    await realEffects(deps, run).run(
      {
        type: "dispatch",
        unit: "run",
        name: "architect-1",
        role: "architect",
        lane: null,
        rung: null,
        thread: null,
        failoverFrom: null,
        brief: "wake",
        notes: [],
      },
      replayRun(run),
    );
    const [d] = listDispatches(run);
    expect(d?.admit.repo).toBe(treeDir(run));
    expect(d?.admit.repo).not.toBe(repo);
  });
});

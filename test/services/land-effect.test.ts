import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { forge } from "../../src/services/land.ts";
import { realEffects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import { treeDir } from "../../src/services/tree-path.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());
const realForge = forge.open;
afterEach(() => {
  forge.open = realForge;
});

describe("the land effect (plan 50, spec D5 stage 1 and D11)", () => {
  it("sets the run's tree up first, lands it, and appends what it did", async () => {
    const { run } = branchRun();
    forge.open = async () => "https://git.example.com/o/r/-/merge_requests/3";
    await appendEvent(run, { type: "run.started", ...startedFields, repo: run.meta.repo, base: "main" });
    await appendEvent(run, {
      type: "land.requested",
      landId: "L1",
      final: false,
      by: "architect-1",
      why: "w",
    });
    await realEffects(fakeDeps(), run).run({ type: "land", landId: "L1" }, replayRun(run));
    expect(existsSync(treeDir(run))).toBe(true);
    expect(readEvents(run).at(-1)).toMatchObject({
      type: "land.done",
      landId: "L1",
      outcome: "pushed",
      branch: "t",
      mr: "https://git.example.com/o/r/-/merge_requests/3",
    });
    expect(replayRun(run).arch.lands.L1?.state).toBe("done");
  });
});

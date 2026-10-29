import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/infra/db.ts";
import { realEffects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { teamMessages } from "../../src/services/team.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

// plan 53 review: catherd's own fast check lives and dies with the run
const tick = () => new Promise<void>((r) => setImmediate(r));
const until = async (f: () => boolean) => {
  while (!f()) await tick();
};

async function started(): Promise<Run> {
  const { run } = freshRun("wallet");
  await appendEvent(run, { type: "run.started", ...startedFields, repo: run.meta.repo, title: "wallet" });
  return run;
}

const fast = (run: Run, checkId: string, command: string) =>
  appendEvent(run, {
    type: "check.requested",
    checkId,
    command,
    scope: "fast",
    base: false,
    fresh: false,
    by: "catherd",
    why: "T1 ended complete: its fast check",
    task: "T1",
  });

describe("catherd's fast check and the end of the run (plan 53 review)", () => {
  it("is killed when the run finishes, and leaves no check.done, no row and no team message behind", async () => {
    const run = await started();
    const mark = join(run.dir, "started");
    await fast(run, "C1", `touch ${mark}; sleep 120; echo '(fail) late'; exit 1`);
    const effects = realEffects(fakeDeps(), run);
    const check = effects.run({ type: "runCheck", checkId: "C1" }, replayRun(run));
    await until(() => existsSync(mark));
    await appendEvent(run, { type: "run.finishing", verdict: "done", why: "w", by: "architect-1" });
    await effects.run({ type: "finish", outcome: "done" }, replayRun(run));
    await check;
    const types = readEvents(run).map((e) => e.type);
    expect(types).not.toContain("check.done");
    expect(types).not.toContain("effect.failed");
    expect(types.at(-1)).toBe("run.ended");
    expect(teamMessages(run)).toEqual([]);
    expect(db().query("SELECT 1 FROM checks WHERE run_id = ?").all(run.id)).toEqual([]);
  });

  it("is killed when the run is cancelled", async () => {
    const run = await started();
    const mark = join(run.dir, "started");
    await fast(run, "C1", `touch ${mark}; sleep 120`);
    const effects = realEffects(fakeDeps(), run);
    const check = effects.run({ type: "runCheck", checkId: "C1" }, replayRun(run));
    await until(() => existsSync(mark));
    await appendEvent(run, { type: "cancel.requested", by: "owner" });
    await effects.run({ type: "cancel", dispatchIds: [] }, replayRun(run));
    await check;
    expect(readEvents(run).map((e) => e.type)).not.toContain("check.done");
  });

  it("records a result that lands while the run is finishing, and posts nothing to the team", async () => {
    const run = await started();
    const mark = join(run.dir, "started");
    const go = join(run.dir, "go");
    await fast(run, "C1", `touch ${mark}; until [ -f ${go} ]; do sleep 0.05; done; echo '(fail) x'; exit 1`);
    const check = realEffects(fakeDeps(), run).run({ type: "runCheck", checkId: "C1" }, replayRun(run));
    await until(() => existsSync(mark));
    await appendEvent(run, { type: "run.finishing", verdict: "done", why: "w", by: "architect-1" });
    writeFileSync(go, "");
    await check;
    expect(readEvents(run).at(-1)).toMatchObject({ type: "check.done", checkId: "C1", exit: 1 });
    expect(teamMessages(run)).toEqual([]);
  });
});

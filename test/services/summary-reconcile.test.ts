import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { writeFileSync } from "node:fs";
import { createRun, runPaths } from "../../src/services/run-store.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { fakeDeps, fakeDispatch, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());
const real = daemonLauncher.launch;
let launched: string[] = [];
beforeEach(() => {
  launched = [];
  daemonLauncher.launch = (id: string) => {
    launched.push(id);
    return 1;
  };
});
afterEach(() => {
  daemonLauncher.launch = real;
});

const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

describe("reviving a daemon", () => {
  it("revives each unfinished 2.0 run at boot and keeps the 1.5 path for the others", async () => {
    const { repo, run: old } = freshRun("old");
    const live = createRun({ repo, title: "live", aLines: [], version: "0.0.0-test" });
    const done = createRun({ repo, title: "done", aLines: [], version: "0.0.0-test" });
    await appendEvent(live, { type: "run.started", ...startedFields });
    await appendEvent(done, { type: "run.started", ...startedFields });
    await appendEvent(done, { type: "run.ended", outcome: "done", reportPath: null });
    // a role of each kind of run that finished with no record
    const mine = await fakeDispatch(
      old,
      { name: "worker-M1.L1" },
      { proc: "dead", exit, reply: "ok\nSTATUS: complete — ok", collect: true },
    );
    const theirs = await fakeDispatch(
      live,
      { name: "worker-M1.L1" },
      { proc: "dead", exit, reply: "ok\nSTATUS: complete — ok", collect: true },
    );
    const report = await reconcileAll(fakeDeps());
    expect(launched).toEqual([live.id]);
    expect(report.finalized).toEqual([mine.admit.dispatchId]);
    expect(report.finalized).not.toContain(theirs.admit.dispatchId);
    await report.done;
  });

  it("revives a dead daemon from the run summary, and says nothing for a 1.5 run", async () => {
    const { repo, run: old } = freshRun("old");
    const live = createRun({ repo, title: "live", aLines: [], version: "0.0.0-test" });
    await appendEvent(live, { type: "run.started", ...startedFields });
    summarizeRun(fakeDeps(), old);
    expect(launched).toEqual([]);
    summarizeRun(fakeDeps(), live);
    expect(launched).toEqual([live.id]);
  });

  it("reports an ended run's outcome and drops the next step state.md still holds", async () => {
    const { run } = freshRun("done");
    await appendEvent(run, { type: "run.started", ...startedFields });
    const e = await appendEvent(run, { type: "run.ended", outcome: "done", reportPath: null });
    writeFileSync(
      runPaths(run.dir).state,
      "# done\n\nLast check: ok\n\nNext: go on\nProtocol next: finish\n",
    );
    const s = summarizeRun(fakeDeps(), run);
    expect(s.ended).toEqual({ at: e.at, outcome: "done" });
    expect(s.stateTail).toEqual(["# done", "Last check: ok"]);
  });

  it("stops an ended run's clock: its wall minutes and minute budget end at run.ended", async () => {
    const { run } = freshRun("done");
    await appendEvent(run, { type: "run.started", ...startedFields });
    const e = await appendEvent(run, { type: "run.ended", outcome: "done", reportPath: null });
    const later = Date.parse(e.at) + 6 * 60 * 60_000;
    const s = summarizeRun(fakeDeps({ view: testView({ budget: { minutes: 60 } }), now: () => later }), run);
    expect(s.totals.wallMinutes).toBeLessThan(1);
    expect(s.budget?.minutes?.spent).toBeLessThan(1);
  });

  it("leaves the run's pauses out of its wall minutes", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { run } = freshRun("paused");
    const start = Date.parse(run.meta.createdAt);
    await appendEvent(run, { type: "run.started", ...startedFields }, new Date(start));
    await appendEvent(run, { type: "run.paused", by: "owner" }, new Date(start + 10 * 60_000));
    await appendEvent(run, { type: "run.resumed", by: "owner" }, new Date(start + 40 * 60_000));
    await appendEvent(
      run,
      { type: "run.ended", outcome: "done", reportPath: null },
      new Date(start + 60 * 60_000),
    );
    expect(summarizeRun(fakeDeps({ now: () => start + 6 * 60 * 60_000 }), run).totals.wallMinutes).toBe(30);
  });

  it("shows a failed revive as a warning, never as a failed read", async () => {
    const { run } = freshRun("live");
    await appendEvent(run, { type: "run.started", ...startedFields });
    daemonLauncher.launch = () => {
      throw new Error("no bun on PATH");
    };
    expect(summarizeRun(fakeDeps(), run).warnings).toContain("daemon: no bun on PATH");
  });
});

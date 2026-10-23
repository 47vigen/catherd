import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { isCatherdError } from "../../src/domain/errors.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { spendOf } from "../../src/services/budget.ts";
import { daemonLauncher, launchStamp } from "../../src/services/daemon.ts";
import { pauseRun, resumeRun } from "../../src/services/run-client.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { runView } from "../../src/services/run-read.ts";
import type { Run } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

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

const started = (run: Run) =>
  appendEvent(run, { type: "run.started", ...startedFields }, new Date(run.meta.createdAt));

describe("pauseRun and resumeRun", () => {
  it("pausing twice appends one run.paused; resuming appends run.resumed and starts the daemon", async () => {
    const { run } = freshRun();
    await started(run);
    const first = await pauseRun(fakeDeps(), { run: run.id });
    expect(first.paused).toBe(true);
    const again = await pauseRun(fakeDeps(), { run: run.id });
    expect(again.since).toBe(first.since);
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started", "run.paused"]);
    launched = [];
    rmSync(launchStamp(run), { force: true });
    expect(await resumeRun(fakeDeps(), { run: run.id })).toEqual({ paused: false });
    expect(await resumeRun(fakeDeps(), { run: run.id })).toEqual({ paused: false });
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started", "run.paused", "run.resumed"]);
    expect(launched).toContain(run.id);
  });

  it("an ended run refuses a pause", async () => {
    const { run } = freshRun();
    await started(run);
    await appendEvent(run, { type: "run.ended", outcome: "done", reportPath: null });
    const e = await pauseRun(fakeDeps(), { run: run.id }).catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_RUN_NOT_LIVE");
  });
});

describe("a run's paused span", () => {
  it("leaves the budget minutes", async () => {
    const { run } = freshRun();
    const t = Date.parse(run.meta.createdAt);
    await started(run);
    await appendEvent(run, { type: "run.paused", by: "owner" }, new Date(t));
    await appendEvent(run, { type: "run.resumed", by: "owner" }, new Date(t + 30 * 60_000));
    expect(spendOf(run, [], [], t + 60 * 60_000).minutes).toBeCloseTo(30, 0);
  });

  it("runView names when the run was paused", async () => {
    const { run } = freshRun();
    await started(run);
    const ev = await appendEvent(run, { type: "run.paused", by: "owner" });
    expect(runView(fakeDeps(), run.id).paused).toBe(ev.at);
    await appendEvent(run, { type: "run.resumed", by: "owner" });
    expect(runView(fakeDeps(), run.id).paused).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tryLock } from "../../src/infra/filelock.ts";
import {
  beat,
  daemonAlive,
  daemonLauncher,
  daemonLockTarget,
  ensureDaemon,
  heartbeatFile,
  readHeartbeat,
  runDaemon,
} from "../../src/services/daemon.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const started: RunEventInput = {
  type: "run.started",
  repo: "/r",
  title: "t",
  aLines: [],
  plan: [],
  base: null,
  engine: "2.0",
};

/** a launcher that records the runs it was asked to start and starts nothing */
function fakeLauncher(): string[] {
  const launched: string[] = [];
  daemonLauncher.launch = (id: string) => {
    launched.push(id);
    return 1;
  };
  return launched;
}
const realLaunch = daemonLauncher.launch;
afterEach(() => {
  daemonLauncher.launch = realLaunch;
});

describe("ensureDaemon", () => {
  it("launches once, says alive while the lock is held, ended after run.ended, 1.5 without events", async () => {
    const launched = fakeLauncher();
    const { run } = freshRun();
    expect(ensureDaemon(run)).toBe("1.5");
    await appendEvent(run, started);
    expect(ensureDaemon(run)).toBe("revived");
    expect(launched).toEqual([run.id]);
    const release = tryLock(daemonLockTarget(run));
    expect(release).not.toBeNull();
    expect(daemonAlive(run)).toBe(true);
    expect(ensureDaemon(run)).toBe("alive");
    expect(launched).toHaveLength(1);
    release?.();
    expect(daemonAlive(run)).toBe(false);
    await appendEvent(run, { type: "run.ended", outcome: "done", reportPath: null });
    expect(ensureDaemon(run)).toBe("ended");
    expect(launched).toHaveLength(1);
  });

  it("does not take a reply that quotes run.ended for the run's end", async () => {
    const launched = fakeLauncher();
    const { run } = freshRun();
    await appendEvent(run, started);
    await appendEvent(run, { type: "report.posted", kind: "landed", unit: "M1", text: '"type":"run.ended"' });
    expect(ensureDaemon(run)).toBe("revived");
    expect(launched).toHaveLength(1);
  });
});

describe("runDaemon", () => {
  it("two concurrent revives leave one daemon", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await appendEvent(run, started);
    const r = await Promise.all([
      runDaemon(deps, run.id, { until: () => true }),
      runDaemon(deps, run.id, { until: () => true }),
    ]);
    expect(r.sort()).toEqual(["ended", "lost-lock"]);
    expect(readEvents(run).filter((e) => e.type === "daemon.started")).toHaveLength(1);
  });

  it("returns at once for an ended run, appending nothing", async () => {
    const { run } = freshRun();
    await appendEvent(run, started);
    await appendEvent(run, { type: "run.ended", outcome: "cancelled", reportPath: null });
    expect(await runDaemon(fakeDeps(), run.id, { until: () => true })).toBe("ended");
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started", "run.ended"]);
  });

  it("writes a heartbeat with its pid, start time and last seq", async () => {
    const { run } = freshRun();
    const deps = fakeDeps({ now: () => Date.parse("2026-10-21T10:00:00.000Z") });
    await appendEvent(run, started);
    await runDaemon(deps, run.id, { until: () => true });
    expect(readHeartbeat(run)).toMatchObject({
      schema: 1,
      pid: process.pid,
      beatAt: "2026-10-21T10:00:00.000Z",
      seq: 2,
      version: "0.0.0-test",
    });
    beat(run, deps, 9);
    expect(readHeartbeat(run)?.seq).toBe(9);
    writeFileSync(heartbeatFile(run), "{");
    expect(readHeartbeat(run)).toBeNull();
    expect(readFileSync(heartbeatFile(run), "utf8")).toBe("{");
  });

  it("frees the lock when it returns", async () => {
    const { run } = freshRun();
    await appendEvent(run, started);
    await runDaemon(fakeDeps(), run.id, { until: () => true });
    expect(daemonAlive(run)).toBe(false);
  });
});

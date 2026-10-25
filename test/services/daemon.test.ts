import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tryLock } from "../../src/infra/filelock.ts";
import {
  beat,
  daemonAlive,
  daemonLauncher,
  daemonDeps,
  daemonLockTarget,
  ensureDaemon,
  heartbeatFile,
  launchStamp,
  readHeartbeat,
  runDaemon,
} from "../../src/services/daemon.ts";
import { pauseMachine, resumeMachine } from "../../src/services/pause.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import type { MilestonePlan, RunEventInput } from "../../src/domain/run-events.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { appendCheckRecord, type CheckRecord } from "../../src/services/milestone-check.ts";
import { type Effects, milestoneChecker, realEffects } from "../../src/services/run-effects.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { newId } from "../domain/run-fixtures.ts";
import type { Deps } from "../../src/services/ports.ts";
import { profileService } from "../../src/services/profile-service.ts";
import { runProfile } from "../../src/services/run-pin.ts";
import { createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { fakeDeps, freshRun, waitFor, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
const realCheck = milestoneChecker.run;
afterEach(() => {
  milestoneChecker.run = realCheck;
});

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
  it("excludes competing revives until the launch completes", async () => {
    const { run } = freshRun();
    await appendEvent(run, started);
    daemonLauncher.launch = () => {
      const competing = tryLock(launchStamp(run));
      competing?.();
      expect(competing).toBeNull();
      return 1;
    };
    expect(ensureDaemon(run)).toBe("revived");
    const release = tryLock(launchStamp(run));
    try {
      expect(release).not.toBeNull();
    } finally {
      release?.();
    }
  });

  it("launches a dead daemon at most once per reviveMs", async () => {
    const launched = fakeLauncher();
    const { run } = freshRun();
    await appendEvent(run, started);
    expect(ensureDaemon(run)).toBe("revived");
    expect(ensureDaemon(run)).toBe("revived");
    expect(launched).toHaveLength(1);
    const past = new Date(Date.now() - 60_000);
    utimesSync(launchStamp(run), past, past);
    expect(ensureDaemon(run)).toBe("revived");
    expect(launched).toHaveLength(2);
  });

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

  it("releases a no-op reminder key for a replacement question", async () => {
    const { run } = freshRun();
    const start = Date.parse("2026-10-21T10:00:00.000Z");
    let now = start + 30 * 60_000;
    let reminders = 0;
    let sleeps = 0;
    await appendEvent(run, started, new Date(start));
    await appendEvent(
      run,
      { type: "question.parked", unit: "run", question: "old", reason: "needs_user" },
      new Date(start),
    );
    await runDaemon(fakeDeps({ now: () => now }), run.id, {
      effects: {
        async run(a) {
          if (a.type === "remind") reminders++;
        },
      },
      clock: {
        now: () => now,
        async sleep() {
          sleeps++;
          if (sleeps === 1) {
            await appendEvent(
              run,
              { type: "question.answered", unit: "run", answer: "done", by: "owner" },
              new Date(now),
            );
            await appendEvent(
              run,
              { type: "question.parked", unit: "run", question: "new", reason: "needs_user" },
              new Date(now),
            );
            now += 30 * 60_000;
          }
        },
      },
      until: () => reminders >= 2 || sleeps >= 5,
    });
    expect(reminders).toBe(2);
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

  it("a lifted machine pause appends one pause.lifted", async () => {
    const { run } = freshRun();
    let now = Date.parse("2026-10-21T10:00:00.000Z");
    pauseMachine(now, "vpn");
    await appendEvent(run, started, new Date(now));
    await appendEvent(
      run,
      {
        type: "dispatch.refused",
        name: "worker-M1.L1",
        unit: "M1.L1",
        code: "E_ADMIT_PAUSED",
        message: "paused",
      },
      new Date(now),
    );
    const lifted = () => readEvents(run).filter((e) => e.type === "pause.lifted").length;
    let sleeps = 0;
    let liftedBeforeResume = -1;
    await runDaemon(fakeDeps({ now: () => now }), run.id, {
      effects: { async run() {} },
      clock: {
        now: () => now,
        async sleep() {
          sleeps++;
          now += 5_000;
          if (sleeps === 5) {
            liftedBeforeResume = lifted();
            resumeMachine(now);
          }
        },
      },
      until: () => sleeps >= 12,
    });
    expect(liftedBeforeResume).toBe(0);
    expect(lifted()).toBe(1);
  });

  it("an effect that hits ENOSPC stops the loop", async () => {
    const { run } = freshRun();
    await appendEvent(run, { ...started, plan: [] });
    await appendEvent(run, { type: "question.parked", unit: "run", question: "q", reason: "needs_user" });
    let slept = 0;
    const err = new Error("ENOSPC: no space left on device, write");
    await expect(
      runDaemon(fakeDeps(), run.id, {
        effects: {
          async run() {
            throw err;
          },
        },
        clock: {
          now: () => Date.now(),
          async sleep() {
            slept++;
          },
        },
        until: () => slept > 50,
      }),
    ).rejects.toBe(err);
    expect(daemonAlive(run)).toBe(false);
  });

  it("a beat that hits ENOSPC keeps the lock until the effect in flight settles", async () => {
    const { run } = freshRun();
    await appendEvent(run, { ...started, plan: [] });
    await appendEvent(run, { type: "question.parked", unit: "run", question: "q", reason: "needs_user" });
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    let entered = false;
    let threw = false;
    let t = Date.now();
    const err = new Error("ENOSPC: no space left on device, write");
    const now = (): number => {
      if (!entered) return t;
      threw = true;
      throw err;
    };
    const done = runDaemon(fakeDeps({ now }), run.id, {
      effects: {
        async run() {
          entered = true;
          await gate;
        },
      },
      clock: {
        now: () => t,
        async sleep(ms) {
          t += ms;
        },
      },
    }).catch((e: unknown) => e);
    await waitFor(() => threw);
    expect(daemonAlive(run)).toBe(true);
    expect(await runDaemon(fakeDeps(), run.id, { until: () => true })).toBe("lost-lock");
    open();
    expect(await done).toBe(err);
    expect(daemonAlive(run)).toBe(false);
  });

  it("frees the lock when it returns", async () => {
    const { run } = freshRun();
    await appendEvent(run, started);
    await runDaemon(fakeDeps(), run.id, { until: () => true });
    expect(daemonAlive(run)).toBe(false);
  });
});

describe("daemonDeps", () => {
  /** the shipped default profile (no architect or verifier rungs) on deps whose own host is unknown, like the daemon's */
  function daemonSide(host: "claude-code" | "codex") {
    withHome();
    const run = createRun({
      repo: tempRepo(),
      title: "t",
      aLines: [],
      version: "0.0.0-test",
      startedBy: { host, sessionId: "s-1", hostSessionId: null, name: null },
    });
    const deps: Deps = fakeDeps({ host: { host: "unknown", session: null, conflict: null } });
    deps.profiles = profileService(() => deps.host);
    return { run, deps };
  }

  it("cannot read the profile on an unknown host, which is how the daemon used to read it", () => {
    const { run, deps } = daemonSide("claude-code");
    expect(() => runProfile(deps, run)).toThrow("needs an orchestration host");
  });

  it.each([
    ["claude-code", "claude:"],
    ["codex", "codex:"],
  ] as const)("resolves the profile on the host %s that started the run", (host, backend) => {
    const { run, deps } = daemonSide(host);
    const scoped = daemonDeps(deps, run);
    expect(scoped.host.host).toBe(host);
    expect(runProfile(scoped, run).roles.architect?.rungs[0]).toStartWith(backend);
    expect(runProfile(scoped, run).roles.verifier?.rungs[0]).toStartWith(backend);
  });

  it("keeps the deps' own host for a run no host started", () => {
    const { deps } = daemonSide("codex");
    const run = createRun({ repo: tempRepo(), title: "t2", aLines: [], version: "0.0.0-test" });
    expect(daemonDeps(deps, run)).toBe(deps);
  });
});

const headOf = (repo: string): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

/**
 * Every role ends ok and every step answers as the real one would. The machine check is not faked: the real effect
 * runs, against a check that passes.
 */
function fakeSteps(run: Run, deps: Deps, clock: { now(): number }): Effects & { actions: Action[] } {
  const real = realEffects(deps, run);
  const add = (e: RunEventInput) => appendEvent(run, e, new Date(clock.now()));
  const actions: Action[] = [];
  return {
    actions,
    async run(a, s) {
      actions.push(a);
      switch (a.type) {
        case "machineCheck":
          return real.run(a, s);
        case "readPlan":
          return void (await add({ type: "plan.ready", milestones: CHECKED_PLAN }));
        case "route":
          await add({
            type: "lanes.routed",
            milestone: a.milestone,
            lanes: [{ lane: "M1.L1", rung: "codex:gpt-6-sol#medium", ladder: ["codex:gpt-6-sol#medium"] }],
          });
          return void (await add({
            type: "preflight.done",
            milestone: a.milestone,
            blocking: [],
            confirm: null,
            lint: [],
          }));
        case "dispatch": {
          const dispatchId = newId();
          await add({
            type: "dispatch.started",
            dispatchId,
            name: a.name,
            role: a.role,
            unit: a.unit,
            lane: a.lane,
            rung: "codex:gpt-6-sol#medium",
            thread: null,
          });
          return void (await add({
            type: "dispatch.ended",
            dispatchId,
            name: a.name,
            unit: a.unit,
            status: "ok",
            replyStatus: "complete",
            reason: null,
            why: "done",
            thread: null,
            head: null,
            environment: null,
            verdict: null,
            findings: [],
            foreign: [],
            replyPath: "",
          }));
        }
        case "fastCheck":
          return void (await add({ type: "check.ran", lane: a.lane, exit: 0, tail: "", foreign: [] }));
        case "commit":
          return void (await add({
            type: "commit.made",
            milestone: a.milestone,
            round: a.round,
            commit: headOf(run.meta.repo),
          }));
        case "land":
          return void (await add({
            type: "milestone.landed",
            milestone: a.milestone,
            commit: headOf(run.meta.repo),
            knownIssues: a.knownIssues,
            digestPath: "",
          }));
        case "report":
          return void (await add({ type: "report.posted", kind: a.kind, unit: a.unit, text: a.text }));
        case "judge":
          // the finished run's rules review proposes no change
          return void (await add({
            type: "judge.decided",
            id: a.input.id,
            unit: a.input.unit,
            kind: a.input.kind,
            decision: { verb: "rules", changes: [] },
            dispatchId: newId(),
          }));
        case "finish":
          return void (await add({ type: "run.ended", outcome: a.outcome, reportPath: null }));
        default:
          return;
      }
    },
  };
}

const CHECKED_PLAN: MilestonePlan[] = [
  {
    id: "M1",
    title: "the core",
    after: [],
    lanes: [{ id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: ["src/a/"] }],
  },
];

describe("the daemon's machine check (plan 40 D1)", () => {
  it("a check-only milestone lands with no verifier dispatch", async () => {
    withHome();
    const repo = tempRepo();
    const run = createRun({ repo, title: "t", aLines: ["A1 it works (Check)"], version: "0.0.0-test" });
    writeFileSync(runPaths(run.dir).plan, "# P\n## M1 — core\nCheck: true\n");
    writeLane(run, "M1.L1", ["src/a/"]);
    // the fake checker: green on the commit it is asked about, and the record a worker would write
    milestoneChecker.run = async (i) => {
      const record: CheckRecord = {
        at: new Date().toISOString(),
        run: run.id,
        milestone: i.milestone,
        command: i.command,
        head: headOf(repo),
        exit: 0,
        durationMs: 1,
        fails: [],
        log: "",
        secrets: "clean",
      };
      appendCheckRecord(repo, record);
      return { running: false, cached: false, record, missing: [], audit: [] };
    };
    const clock = {
      now: () => Date.parse("2026-10-21T10:00:00.000Z"),
      sleep: () => new Promise<void>((r) => setImmediate(r)),
    };
    const deps = fakeDeps({ now: clock.now });
    const fx = fakeSteps(run, deps, clock);
    // the owner gave the plan: no approval waits between plan.ready and the first lane
    await appendEvent(
      run,
      { ...started, aLines: ["A1 it works (Check)"], plan: ["plan.md"] },
      new Date(clock.now()),
    );
    expect(await runDaemon(deps, run.id, { effects: fx, clock })).toBe("ended");
    expect(fx.actions.filter((a) => a.type === "dispatch" && a.name === "verifier-M1")).toEqual([]);
    expect(readEvents(run).findLast((e) => e.type === "milestone.checked")).toMatchObject({
      milestone: "M1",
      checkOnly: true,
      uncovered: [],
    });
    expect(readEvents(run).map((e) => e.type)).toContain("milestone.landed");
  });
});

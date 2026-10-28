import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
import { appendEvent, eventsFile, readEvents } from "../../src/services/run-events-store.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { realEffects } from "../../src/services/run-effects.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import type { Deps } from "../../src/services/ports.ts";
import { profileService } from "../../src/services/profile-service.ts";
import { runProfile } from "../../src/services/run-pin.ts";
import { createRun } from "../../src/services/run-store.ts";
import { fakeDeps, freshRun, insertEarlier, waitFor } from "./helpers.ts";

afterEach(snapshotEnv());

const started: RunEventInput = {
  type: "run.started",
  repo: "/r",
  title: "t",
  aLines: [],
  plan: [],
  base: null,
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

  it("never drives a run an earlier build started: no daemon, no event (plan 48, spec D16)", async () => {
    const { run } = freshRun();
    // an earlier build wrote its events at version 1
    insertEarlier(run);
    expect(ensureDaemon(run)).toBe("earlier");
    expect(await runDaemon(fakeDeps(), run.id, { until: () => true })).toBe("ended");
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started"]);
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

  it("an effect that cannot write its effect.failed stops the loop, whatever the error", async () => {
    const { run } = freshRun();
    await appendEvent(run, { ...started, plan: [] });
    await appendEvent(run, { type: "question.parked", unit: "run", question: "q", reason: "needs_user" });
    const real = realEffects(fakeDeps(), run);
    let slept = 0;
    const result = await runDaemon(fakeDeps(), run.id, {
      effects: {
        async run(_a, s) {
          chmodSync(eventsFile(run), 0o444);
          try {
            await real.run({ type: "runCheck", checkId: "C9" }, s);
          } finally {
            chmodSync(eventsFile(run), 0o644);
          }
        },
      },
      clock: {
        now: () => Date.now(),
        async sleep() {
          slept++;
        },
      },
      until: () => slept > 50,
    }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(Error);
    expect(daemonAlive(run)).toBe(false);
  });

  it("a watch in flight does not hold the lock after the loop fails", async () => {
    const { run } = freshRun();
    await appendEvent(run, { ...started, plan: [] });
    await appendEvent(run, {
      type: "dispatch.started",
      dispatchId: "D1",
      name: "worker-M1.L1",
      role: "worker",
      unit: "M1.L1",
      lane: "M1.L1",
      rung: "codex:gpt-6-sol#high",
      thread: null,
    });
    await appendEvent(run, { type: "question.parked", unit: "run", question: "q", reason: "needs_user" });
    const seen: string[] = [];
    let slept = 0;
    const result = await runDaemon(fakeDeps(), run.id, {
      effects: {
        run(a) {
          seen.push(a.type);
          return a.type === "watch" ? new Promise<void>(() => {}) : Promise.reject(new Error("E_IO_LOCK"));
        },
      },
      clock: {
        now: () => Date.now(),
        async sleep() {
          slept++;
        },
      },
      until: () => slept > 50,
    }).catch((e: unknown) => e);
    expect(seen).toContain("watch");
    expect(result).toBeInstanceOf(Error);
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

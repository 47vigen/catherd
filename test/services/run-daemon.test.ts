import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MilestonePlan, RunEvent, RunEventInput } from "../../src/domain/run-events.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { daemonAlive, daemonLimits, readHeartbeat, runDaemon } from "../../src/services/daemon.ts";
import type { Effects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { PLAN, newId, startedFields } from "../domain/run-fixtures.ts";
import { fakeDeps, freshRun, waitFor } from "./helpers.ts";

afterEach(snapshotEnv());
const limits = { ...daemonLimits };
beforeEach(() => {
  daemonLimits.beatMs = 0;
});
afterEach(() => Object.assign(daemonLimits, limits));

const T0 = Date.parse("2026-10-21T10:00:00.000Z");

/** A clock the test drives: a sleep advances it and yields, so effects make progress without any real wait. */
function drivenClock() {
  let t = T0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await new Promise<void>((r) => setImmediate(r));
    },
  };
}

type Script = (a: Action, s: Parameters<Effects["run"]>[1]) => RunEventInput[] | Promise<RunEventInput[]>;

/** Effects that answer each action with the events the real one would append, and keep every action. */
function scripted(run: Run, clock: { now(): number }, script: Script) {
  const actions: Action[] = [];
  const fx: Effects & { actions: Action[] } = {
    actions,
    async run(a, s) {
      actions.push(a);
      for (const e of await script(a, s)) await appendEvent(run, e, new Date(clock.now()));
    },
  };
  return fx;
}

const ended = (
  name: string,
  unit: string,
  over: Partial<Extract<RunEventInput, { type: "dispatch.ended" }>> = {},
): Extract<RunEventInput, { type: "dispatch.ended" }> => ({
  type: "dispatch.ended",
  dispatchId: "",
  name,
  unit,
  status: "ok",
  replyStatus: "complete",
  reason: null,
  why: "done",
  thread: "t-1",
  head: null,
  environment: null,
  verdict: null,
  findings: [],
  foreign: [],
  replyPath: "",
  ...over,
});

/** The happy path: every action succeeds at once. `tweak` replaces the answer to some of them. */
function happy(plan: MilestonePlan[] = PLAN, tweak: Script = () => []): Script {
  return async (a, s) => {
    const own = await tweak(a, s);
    if (own.length) return own;
    switch (a.type) {
      case "dispatch": {
        const dispatchId = newId();
        return [
          {
            type: "dispatch.started",
            dispatchId,
            name: a.name,
            role: a.role,
            unit: a.unit,
            lane: a.lane,
            rung: a.rung ?? "codex:gpt-6-sol#medium",
            thread: a.thread,
          },
          ended(a.name, a.unit, {
            dispatchId,
            verdict: a.brief === "verify" ? "pass" : null,
            head: a.brief === "verify" ? "c".repeat(40) : null,
          }),
        ];
      }
      case "readPlan":
        return [{ type: "plan.ready", milestones: plan }];
      case "route": {
        const mp = plan.find((m) => m.id === a.milestone) as MilestonePlan;
        return [
          {
            type: "lanes.routed",
            milestone: a.milestone,
            lanes: mp.lanes.map((l) => ({
              lane: l.id,
              rung: "codex:gpt-6-sol#medium",
              ladder: ["codex:gpt-6-sol#medium"],
            })),
          },
          { type: "preflight.done", milestone: a.milestone, blocking: [], confirm: null },
        ];
      }
      case "fastCheck":
        return [{ type: "check.ran", lane: a.lane, exit: 0, tail: "", foreign: [] }];
      case "commit":
        return [{ type: "commit.made", milestone: a.milestone, round: a.round, commit: "c".repeat(40) }];
      case "land":
        return [
          {
            type: "milestone.landed",
            milestone: a.milestone,
            commit: "c".repeat(40),
            knownIssues: a.knownIssues,
            digestPath: "",
          },
        ];
      case "report":
        return [{ type: "report.posted", kind: a.kind, unit: a.unit, text: a.text }];
      case "finish":
        return [{ type: "run.ended", outcome: a.outcome, reportPath: null }];
      default:
        return [];
    }
  };
}

async function start(run: Run, plan: string[] = ["plan.md"]): Promise<void> {
  await appendEvent(run, { type: "run.started", ...startedFields, plan }, new Date(T0));
}

const types = (run: Run): string[] => readEvents(run).map((e) => e.type);
const lastEvent = (run: Run): RunEvent | undefined => readEvents(run).at(-1);
const endOf = (run: Run): RunEvent | undefined => readEvents(run).find((e) => e.type === "run.ended");

describe("the daemon loop", () => {
  it("drives a two-milestone run to the end with fake effects and no model", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    const fx = scripted(run, clock, happy());
    await start(run);
    expect(await runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock })).toBe("ended");
    expect(endOf(run)).toMatchObject({ type: "run.ended", outcome: "done" });
    expect(
      fx.actions.filter((a) => a.type === "land").map((a) => (a as { milestone: string }).milestone),
    ).toEqual(["M1", "M2"]);
    // the milestones went one after the other
    const landed = readEvents(run)
      .filter((e) => e.type === "milestone.landed" || e.type === "lanes.routed")
      .map((e) => `${e.type}:${(e as { milestone: string }).milestone}`);
    expect(landed).toEqual([
      "lanes.routed:M1",
      "milestone.landed:M1",
      "lanes.routed:M2",
      "milestone.landed:M2",
    ]);
    expect(daemonAlive(run)).toBe(false);
    expect(readHeartbeat(run)?.seq).toBe(readEvents(run).length);
  });

  it("resumes by replay after a crash, re-attaching the live dispatch without dispatching it again", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    await start(run);
    await appendEvent(run, { type: "plan.ready", milestones: PLAN }, new Date(T0));
    await appendEvent(
      run,
      {
        type: "lanes.routed",
        milestone: "M1",
        lanes: [
          { lane: "M1.L1", rung: "codex:gpt-6-sol#medium", ladder: [] },
          { lane: "M1.L2", rung: "codex:gpt-6-sol#medium", ladder: [] },
        ],
      },
      new Date(T0),
    );
    await appendEvent(
      run,
      { type: "preflight.done", milestone: "M1", blocking: [], confirm: null },
      new Date(T0),
    );
    await appendEvent(
      run,
      {
        type: "dispatch.started",
        dispatchId: "LIVE",
        name: "worker-M1.L1",
        role: "worker",
        unit: "M1.L1",
        lane: "M1.L1",
        rung: "codex:gpt-6-sol#medium",
        thread: null,
      },
      new Date(T0),
    );
    const fx = scripted(
      run,
      clock,
      happy(PLAN, (a) =>
        a.type === "watch" ? [ended("worker-M1.L1", "M1.L1", { dispatchId: "LIVE" })] : [],
      ),
    );
    await runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock });
    expect(fx.actions.filter((a) => a.type === "watch")).toEqual([{ type: "watch", dispatchId: "LIVE" }]);
    // the dispatch that was live is never started a second time
    expect(fx.actions.filter((a) => a.type === "dispatch" && a.name === "worker-M1.L1")).toEqual([]);
    expect(endOf(run)).toMatchObject({ type: "run.ended", outcome: "done" });
  });

  it("re-issues an action decided before the crash whose event never came", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    await start(run);
    await appendEvent(run, { type: "plan.ready", milestones: PLAN }, new Date(T0));
    // M1 is routed, and its lanes were to be dispatched when the daemon died
    await appendEvent(
      run,
      {
        type: "lanes.routed",
        milestone: "M1",
        lanes: [
          { lane: "M1.L1", rung: "codex:gpt-6-sol#medium", ladder: [] },
          { lane: "M1.L2", rung: "codex:gpt-6-sol#medium", ladder: [] },
        ],
      },
      new Date(T0),
    );
    await appendEvent(
      run,
      { type: "preflight.done", milestone: "M1", blocking: [], confirm: null },
      new Date(T0),
    );
    const fx = scripted(run, clock, happy());
    await runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock });
    expect(fx.actions.find((a) => a.type === "dispatch" && a.name === "worker-M1.L1")).toBeDefined();
    expect(endOf(run)).toMatchObject({ type: "run.ended", outcome: "done" });
  });

  it("never issues an action twice while its confirming event is pending", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const fx = scripted(
      run,
      clock,
      happy(PLAN, async (a) => {
        if (a.type === "dispatch" && a.name === "architect") await gate;
        return [];
      }),
    );
    await start(run);
    const done = runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock });
    await waitFor(() => fx.actions.find((a) => a.type === "dispatch"));
    // events keep arriving while the architect's dispatch has not started: next() says "dispatch" every time
    for (let i = 0; i < 3; i++)
      await appendEvent(
        run,
        { type: "report.posted", kind: "started", unit: "run", text: "x" },
        new Date(T0),
      );
    await waitFor(() => (readHeartbeat(run)?.seq ?? 0) >= readEvents(run).length);
    expect(fx.actions.filter((a) => a.type === "dispatch")).toHaveLength(1);
    open();
    expect(await done).toBe("ended");
    expect(fx.actions.filter((a) => a.type === "dispatch" && a.name === "architect")).toHaveLength(1);
  });

  it("appends one tick when a hold ends, and dispatches the held lane then", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    // the clock jumps a minute per sleep, so the half hour passes in thirty turns of the loop
    daemonLimits.pollMs = 60_000;
    let limited = false;
    const fx = scripted(
      run,
      clock,
      happy(PLAN, (a, s) => {
        if (a.type !== "dispatch" || a.name !== "worker-M1.L1") return [];
        if (!limited) {
          limited = true;
          const dispatchId = newId();
          return [
            {
              type: "dispatch.started",
              dispatchId,
              name: a.name,
              role: a.role,
              unit: a.unit,
              lane: a.lane,
              rung: "codex:gpt-6-sol#medium",
              thread: null,
            },
            ended(a.name, a.unit, { dispatchId, status: "limit", replyStatus: null, thread: null }),
          ];
        }
        // the quota is held: no rung is free until the hold ends
        return a.failoverFrom && Object.values(s.holds).some((until) => until > s.at)
          ? [{ type: "dispatch.refused", name: a.name, unit: a.unit, code: "E_ALL_HELD", message: "held" }]
          : [];
      }),
    );
    await start(run);
    await runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock });
    expect(types(run).filter((t) => t === "tick")).toHaveLength(1);
    const names = readEvents(run).flatMap((e) => (e.type === "dispatch.refused" ? [e.code] : []));
    expect(names).toEqual(["E_ALL_HELD"]);
    expect(endOf(run)).toMatchObject({ type: "run.ended", outcome: "done" });
    const tick = readEvents(run).find((e) => e.type === "tick");
    expect(Date.parse(tick?.at ?? "") - T0).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("waits for in-flight effects after run.ended, then exits and frees the lock", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    let settled = false;
    const fx = scripted(
      run,
      clock,
      happy(PLAN, async (a) => {
        if (a.type === "report" && a.kind === "cancelled") await gate;
        return [];
      }),
    );
    await start(run);
    await appendEvent(run, { type: "cancel.requested", by: "owner" }, new Date(T0));
    const done = runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock }).then((r) => {
      settled = true;
      return r;
    });
    await waitFor(() => fx.actions.find((a) => a.type === "report"));
    expect(endOf(run)).toMatchObject({ type: "run.ended", outcome: "cancelled" });
    expect(settled).toBe(false);
    expect(daemonAlive(run)).toBe(true);
    open();
    expect(await done).toBe("ended");
    expect(lastEvent(run)).toMatchObject({ type: "report.posted", kind: "cancelled" });
    expect(daemonAlive(run)).toBe(false);
  });

  it("frees a failed action's key, so the machine issues it once more", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    let failed = false;
    const fx = scripted(
      run,
      clock,
      happy(PLAN, (a) => {
        if (a.type !== "fastCheck" || a.lane !== "M1.L1" || failed) return [];
        failed = true;
        return [{ type: "effect.failed", action: "fastCheck", unit: "M1.L1", message: "the runner died" }];
      }),
    );
    await start(run);
    await runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock });
    expect(fx.actions.filter((a) => a.type === "fastCheck" && a.lane === "M1.L1")).toHaveLength(2);
    expect(endOf(run)).toMatchObject({ type: "run.ended", outcome: "done" });
  });
});

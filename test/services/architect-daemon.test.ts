import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { daemonLimits, runDaemon } from "../../src/services/daemon.ts";
import type { Effects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { newId, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
const limits = { ...daemonLimits };
beforeEach(() => {
  daemonLimits.beatMs = 0;
});
afterEach(() => Object.assign(daemonLimits, limits));

const T0 = Date.parse("2026-10-28T10:00:00.000Z");

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

const ended = (dispatchId: string, name: string, unit: string): RunEventInput => ({
  type: "dispatch.ended",
  dispatchId,
  name,
  unit,
  status: "ok",
  replyStatus: "complete",
  reason: null,
  why: "done",
  thread: `th-${name}`,
  head: null,
  environment: null,
  verdict: null,
  findings: [],
  foreign: [],
  replyPath: `roles/${name}/${dispatchId}/reply.md`,
});

describe("the daemon on the architect engine (plan 47)", () => {
  it("wakes the architect, runs the task it delegated, wakes it with the result, and ends when it finishes", async () => {
    const { run } = freshRun();
    const clock = drivenClock();
    const actions: Action[] = [];
    const fx: Effects = {
      async run(a) {
        actions.push(a);
        const add = (e: RunEventInput) => appendEvent(run, e, new Date(clock.now()));
        if (a.type === "finish")
          return void (await add({ type: "run.ended", outcome: a.outcome, reportPath: null }));
        if (a.type !== "dispatch") return;
        const dispatchId = newId();
        const rung = a.rung ?? "claude-code:claude-opus-5-5#high";
        await add({
          type: "dispatch.started",
          dispatchId,
          name: a.name,
          role: a.role,
          unit: a.unit,
          lane: null,
          rung,
          thread: a.thread,
          ...(a.upTo === undefined ? {} : { upTo: a.upTo }),
        });
        if (a.name === "architect-1")
          await add({
            type: "task.delegated",
            taskId: "T1",
            role: "worker",
            rung: "codex:gpt-6-sol#high",
            thread: null,
            ledgerTask: null,
            by: a.name,
            why: "write it",
          });
        if (a.name === "architect-2")
          await add({ type: "run.finishing", verdict: "done", by: a.name, why: "T1 is done" });
        await add(ended(dispatchId, a.name, a.unit));
      },
    };
    await appendEvent(run, { type: "run.started", ...startedFields, engine: "architect" }, new Date(T0));
    expect(await runDaemon(fakeDeps({ now: clock.now }), run.id, { effects: fx, clock })).toBe("ended");
    expect(actions.map((a) => (a.type === "dispatch" ? a.name : a.type))).toEqual([
      "architect-1",
      "T1",
      "architect-2",
      "finish",
    ]);
    expect(actions[2]).toMatchObject({ thread: "th-architect-1", brief: "wake" });
    expect(readEvents(run).at(-1)).toMatchObject({ type: "run.ended", outcome: "done" });
  });
});

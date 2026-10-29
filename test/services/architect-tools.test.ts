import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectTool } from "../../src/domain/role-tools.ts";
import { callArchitectTool, type ToolCaller } from "../../src/services/architect-tools.ts";
import { ledgerTasks } from "../../src/services/ledger-store.ts";
import { appendEvent, readEvents, replayRun, withEventsLock } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps, freshRun, insertEarlier, testView } from "./helpers.ts";

afterEach(snapshotEnv());

const ARCHITECT: ToolCaller = { name: "architect-1", role: "architect" };
const WORKER: ToolCaller = { name: "T1", role: "worker" };

async function architectRun(): Promise<Run> {
  const { run } = freshRun();
  await appendEvent(run, { type: "run.started", ...startedFields });
  return run;
}

const view = testView();
view.roles.researcher = { enabled: true, access: "read-only", rungs: ["codex:gpt-6-luna#high"] };
const deps = fakeDeps({ view });

const call = (run: Run, tool: ArchitectTool, args: unknown, caller: ToolCaller = ARCHITECT) =>
  callArchitectTool({ deps, run, caller, pollMs: 1 }, tool, args);

const last = (run: Run) => readEvents(run).at(-1);

describe("the architect's tools (plan 47, spec D3 and D12)", () => {
  it("delegate_task writes the brief, appends task.delegated with the why, and returns at once", async () => {
    const run = await architectRun();
    expect(
      await call(run, "delegate_task", { role: "worker", task: "write the wallet", why: "first" }),
    ).toEqual({
      taskId: "T1",
      rung: "codex:gpt-6-luna#high",
      sameFamily: false,
      thread: null,
      reportPath: null,
    });
    expect(readFileSync(join(run.dir, "tasks", "T1", "brief.md"), "utf8")).toBe("write the wallet\n");
    expect(last(run)).toMatchObject({
      type: "task.delegated",
      taskId: "T1",
      role: "worker",
      rung: "codex:gpt-6-luna#high",
      by: "architect-1",
      why: "first",
    });
    expect(
      await call(run, "delegate_task", { role: "researcher", task: "how does it sign?", why: "w" }),
    ).toMatchObject({
      taskId: "T2",
      reportPath: "research/T2.md",
    });
  });

  it("refuses a rung off the role's ladder, an unknown ledger task, and a role the profile turns off", async () => {
    const run = await architectRun();
    const refused = (args: object) => call(run, "delegate_task", { task: "x", why: "w", ...args });
    await expect(refused({ role: "worker", rung: "codex:other#low" })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
    await expect(refused({ role: "worker", ledgerTask: "L9" })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
    await expect(refused({ role: "artist" })).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
    await expect(
      refused({ role: "worker" }).then(() => refused({ role: "architect" })),
    ).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
  });

  it("a worker delegates only to the standing roles and sees only its own tasks (D12)", async () => {
    const run = await architectRun();
    await call(run, "delegate_task", { role: "worker", task: "x", why: "w" });
    await expect(
      call(run, "delegate_task", { role: "worker", task: "x", why: "w" }, WORKER),
    ).rejects.toMatchObject({
      code: "E_ROLE_SCOPE",
    });
    expect(
      await call(run, "delegate_task", { role: "researcher", task: "q", why: "w" }, WORKER),
    ).toMatchObject({ taskId: "T2" });
    expect(await call(run, "task_status", { taskId: "T2" }, WORKER)).toMatchObject({ workState: "waiting" });
    await expect(call(run, "task_status", { taskId: "T1" }, WORKER)).rejects.toMatchObject({
      code: "E_ROLE_SCOPE",
    });
    await expect(call(run, "check", { command: "true", why: "w" }, WORKER)).rejects.toMatchObject({
      code: "E_ROLE_SCOPE",
    });
  });

  it("task_cancel stops a queued task; task_status of a finished one marks it read once", async () => {
    const run = await architectRun();
    await call(run, "delegate_task", { role: "worker", task: "x", why: "w" });
    expect(await call(run, "task_cancel", { taskId: "T1", why: "not needed" })).toEqual({
      taskId: "T1",
      workState: "stopped",
    });
    expect(replayRun(run).arch?.tasks.T1?.state).toBe("cancelled");
    expect(await call(run, "task_status", { taskId: "T1" })).toMatchObject({
      workState: "stopped",
      stopReason: "cancelled",
    });
    expect(readEvents(run).filter((e) => e.type === "task.read")).toHaveLength(1);
    await call(run, "task_status", { taskId: "T1" });
    expect(readEvents(run).filter((e) => e.type === "task.read")).toHaveLength(1);
  });

  it("thread_send queues a message to a task and records it; to a finished task it resumes its thread", async () => {
    const run = await architectRun();
    await call(run, "delegate_task", { role: "worker", task: "x", why: "w" });
    expect(await call(run, "thread_send", { to: "T1", text: "use Money", why: "w" })).toEqual({
      n: 1,
      delivery: "queued",
    });
    expect(last(run)).toMatchObject({
      type: "thread.sent",
      to: "T1",
      n: 1,
      delivery: "queued",
      by: "architect-1",
    });
    await appendEvent(run, {
      type: "dispatch.started",
      dispatchId: "D1",
      name: "T1",
      role: "worker",
      unit: "T1",
      lane: null,
      rung: "codex:gpt-6-luna#high",
      thread: null,
    });
    await appendEvent(run, {
      type: "dispatch.ended",
      dispatchId: "D1",
      name: "T1",
      unit: "T1",
      status: "ok",
      replyStatus: "complete",
      reason: null,
      why: "ok",
      thread: "th-1",
      head: null,
      environment: null,
      verdict: null,
      findings: [],
      replyPath: "roles/T1/D1/reply.md",
    });
    expect(
      await call(run, "thread_send", { to: "T1", text: "and the refund path?", why: "follow-up" }),
    ).toMatchObject({
      taskId: "T2",
      thread: "th-1",
      delivery: "resumed",
    });
    expect(replayRun(run).arch?.tasks.T2).toMatchObject({ role: "worker", thread: "th-1", state: "queued" });
    expect(
      ((await call(run, "thread_read", { from: "architect-1" })) as { messages: unknown[] }).messages,
    ).toHaveLength(1);
  });

  it("delegate_task records a task's fast check, the profile's for a worker without one, and none for a reader (plan 53)", async () => {
    const run = await architectRun();
    const checkOf = async (args: object) => {
      await call(run, "delegate_task", { task: "x", why: "w", ...args });
      return (last(run) as { check?: string }).check;
    };
    view.fastCheck = "bun run lint";
    try {
      expect(await checkOf({ role: "worker", check: " bun test test/a.test.ts " })).toBe(
        "bun test test/a.test.ts",
      );
      expect(await checkOf({ role: "worker" })).toBe("bun run lint");
      expect(await checkOf({ role: "writer" })).toBeUndefined();
      expect(await checkOf({ role: "writer", check: "bun run format:check" })).toBe("bun run format:check");
      await expect(checkOf({ role: "researcher", check: "bun test" })).rejects.toMatchObject({
        code: "E_INPUT_INVALID",
      });
    } finally {
      delete view.fastCheck;
    }
    expect(replayRun(run).arch?.tasks.T1?.check).toBe("bun test test/a.test.ts");
    expect(replayRun(run).arch?.tasks.T3?.check).toBeNull();
    const log = makeLog();
    endDispatch(log, startDispatch(log, { name: "T1", unit: "T1" }), {
      name: "T1",
      unit: "T1",
      thread: "th-1",
    });
    for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    // a follow-up on a finished task's thread checks the same work
    expect(
      await call(run, "thread_send", { to: "T1", text: "and the refund path?", why: "w" }),
    ).toMatchObject({
      taskId: "T5",
    });
    expect(replayRun(run).arch?.tasks.T5?.check).toBe("bun test test/a.test.ts");
    // a worker delegated with no fast check keeps none on its follow-up, though the profile gained one since
    const { taskId } = (await call(run, "delegate_task", { role: "worker", task: "y", why: "w" })) as {
      taskId: string;
    };
    expect(replayRun(run).arch?.tasks[taskId]?.check).toBeNull();
    endDispatch(log, startDispatch(log, { name: taskId, unit: taskId }), {
      name: taskId,
      unit: taskId,
      thread: "th-2",
    });
    for (const { v: _v, seq: _s, at: _a, ...e } of log.events.slice(-2)) await appendEvent(run, e as never);
    view.fastCheck = "bun run lint";
    let followUp: string;
    try {
      ({ taskId: followUp } = (await call(run, "thread_send", {
        to: taskId,
        text: "one more",
        why: "w",
      })) as {
        taskId: string;
      });
    } finally {
      delete view.fastCheck;
    }
    expect(replayRun(run).arch?.tasks[followUp]?.check).toBeNull();
  });

  it("thread_wait returns at a task's end and times out on a running one", async () => {
    const run = await architectRun();
    await call(run, "delegate_task", { role: "worker", task: "x", why: "w" });
    expect(await call(run, "thread_wait", { taskIds: ["T1"], timeoutSec: 0 })).toEqual({
      taskId: null,
      workState: null,
      timedOut: true,
    });
    await call(run, "task_cancel", { taskId: "T1", why: "w" });
    expect(await call(run, "thread_wait", { taskIds: ["T1"], timeoutSec: 0 })).toEqual({
      taskId: "T1",
      workState: "stopped",
      timedOut: false,
    });
  });

  it("check, ledger, ask_owner and finish append what the daemon acts on, each with its why", async () => {
    const run = await architectRun();
    expect(await call(run, "check", { command: "bun test", why: "before the replan" })).toEqual({
      checkId: "C1",
    });
    expect(last(run)).toMatchObject({
      type: "check.requested",
      checkId: "C1",
      scope: "full",
      base: false,
      fresh: false,
    });
    expect(
      await call(run, "ledger", {
        tasks: { add: [{ id: "L1", goal: "the wallet" }] },
        progress: "planned",
        why: "w",
      }),
    ).toEqual({ tasks: 1 });
    expect(ledgerTasks(run).map((t) => t.id)).toEqual(["L1"]);
    expect(last(run)).toMatchObject({ type: "ledger.changed", tasks: ["L1"], progress: true });
    expect(JSON.parse(readFileSync(join(run.dir, "ledger", "tasks.json"), "utf8"))).toMatchObject([
      { id: "L1", state: "todo" },
    ]);
    await expect(call(run, "ask_owner", { question: "q", scope: "run", why: "w" })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
    expect(
      await call(run, "ask_owner", {
        question: "Deploy now? I recommend yes.",
        options: ["yes", "no"],
        scope: "run",
        stopClass: "production",
        why: "w",
      }),
    ).toEqual({ unit: "run", parked: true });
    expect(replayRun(run).questions.run).toMatchObject({
      reason: "owner",
      question: "(production) Deploy now? I recommend yes.\n- yes\n- no",
    });
    expect(await call(run, "finish", { verdict: "done", why: "shipped" })).toEqual({ finishing: "done" });
    expect(replayRun(run).arch?.finishing).toEqual({ verdict: "done", why: "shipped" });
  });

  it("refuses a same-rung retry with nothing new, and a ledger task past its attempts (plan 48, spec D10)", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "run.started", ...startedFields, caps: { wallMin: 720, attempts: 2 } });
    await call(run, "ledger", { tasks: { add: [{ id: "L1", goal: "the parser" }] }, why: "w" });
    const work = (rung?: string) =>
      call(run, "delegate_task", {
        role: "worker",
        task: "parse it",
        ledgerTask: "L1",
        why: "w",
        ...(rung ? { rung } : {}),
      });
    const end = async (taskId: string, replyStatus: "blocked" | "complete") => {
      const log = makeLog();
      const id = startDispatch(log, { name: taskId, unit: taskId });
      endDispatch(log, id, { name: taskId, unit: taskId, replyStatus, why: "the parser loops" });
      for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    };
    await work();
    await end("T1", "blocked");
    await expect(work()).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
      message: expect.stringContaining("stalled"),
    });
    expect(await work("codex:gpt-6-sol#high")).toMatchObject({ taskId: "T2" });
    await end("T2", "complete");
    await expect(work("codex:gpt-6-sol#high")).rejects.toMatchObject({
      message: expect.stringContaining("has had its 2 attempts"),
    });
  });

  it("with no rung, climbs a ledger task's ladder after a failed attempt and keeps it after a provider error (plan 49, spec D7)", async () => {
    const run = await architectRun();
    await call(run, "ledger", { tasks: { add: [{ id: "L1", goal: "the parser" }] }, why: "w" });
    const work = () =>
      call(run, "delegate_task", { role: "worker", task: "parse it", ledgerTask: "L1", why: "w" });
    const end = async (taskId: string, o: Parameters<typeof endDispatch>[2]) => {
      const log = makeLog();
      const id = startDispatch(log, { name: taskId, unit: taskId });
      endDispatch(log, id, { ...o, name: taskId, unit: taskId });
      for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    };
    expect(await work()).toMatchObject({ taskId: "T1", rung: "codex:gpt-6-luna#high" });
    await end("T1", { name: "T1", unit: "T1", status: "failed", replyStatus: null });
    expect(await work()).toMatchObject({ taskId: "T2", rung: "codex:gpt-6-sol#medium" });
    await end("T2", { name: "T2", unit: "T2", replyStatus: "blocked", reason: "provider_error" });
    await call(run, "ledger", { tasks: { set: [{ id: "L1", goal: "the parser, retried" }] }, why: "w" });
    expect(await work()).toMatchObject({ taskId: "T3", rung: "codex:gpt-6-sol#medium" });
    expect(await call(run, "capabilities", {})).toMatchObject({
      roles: {
        worker: {
          ladder: expect.arrayContaining(["codex:gpt-6-sol#xhigh"]),
          default: "codex:gpt-6-luna#high",
        },
      },
    });
  });

  it("with no rung, skips a rung whose quota is held for the next free one on the ladder (plan 52)", async () => {
    const run = await architectRun();
    const mixed = testView();
    mixed.roles.researcher = {
      enabled: true,
      access: "read-only",
      rungs: ["codex:gpt-6-luna#high", "claude-code:claude-sonnet-5-5#high"],
    };
    const ask = () =>
      callArchitectTool(
        { deps: fakeDeps({ view: mixed }), run, caller: ARCHITECT, pollMs: 1 },
        "delegate_task",
        {
          role: "researcher",
          task: "map it",
          why: "w",
        },
      );
    expect(await ask()).toMatchObject({ rung: "codex:gpt-6-luna#high" });
    const log = makeLog();
    endDispatch(log, startDispatch(log, { name: "T1", unit: "T1", role: "researcher" }), {
      name: "T1",
      unit: "T1",
      status: "limit",
    });
    for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    expect(await ask()).toMatchObject({ rung: "claude-code:claude-sonnet-5-5#high" });
  });

  it("checks the attempts cap under the events lock, not before it (plan 48, R20)", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "run.started", ...startedFields, caps: { wallMin: 720, attempts: 1 } });
    await call(run, "ledger", { tasks: { add: [{ id: "L1", goal: "the parser" }] }, why: "w" });
    let late!: Promise<unknown>;
    // a delegation that starts while another holds the lock must see that one's attempt once it gets in
    await withEventsLock(run, (add) => {
      late = call(run, "delegate_task", { role: "worker", task: "parse it", ledgerTask: "L1", why: "w" });
      add({
        type: "task.delegated",
        taskId: "T1",
        role: "worker",
        rung: "codex:gpt-6-sol#high",
        thread: null,
        ledgerTask: "L1",
        by: "architect-1",
        why: "w",
      });
    });
    await expect(late).rejects.toMatchObject({ message: expect.stringContaining("has had its 1 attempts") });
  });

  it("capabilities names each role's rungs, the slots and the budget; an earlier build's run has none of these tools", async () => {
    const run = await architectRun();
    expect(await call(run, "capabilities", {})).toMatchObject({
      roles: { worker: { default: "codex:gpt-6-luna#high" }, researcher: expect.anything() },
      writers: { running: 0, cap: 4 },
      standing: { running: 0, cap: 4 },
      queued: 0,
    });
    const old = freshRun().run;
    insertEarlier(old);
    await expect(call(old, "capabilities", {})).rejects.toMatchObject({ code: "E_ROLE_SCOPE" });
  });
});

describe("land (plan 50, spec D11)", () => {
  it("appends land.requested with its why in a base run, and refuses a run without a base", async () => {
    const run = await architectRun();
    await expect(call(run, "land", { why: "w" })).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
    const { run: based } = branchRun();
    await appendEvent(based, { type: "run.started", ...startedFields, base: "main" });
    expect(await call(based, "land", { final: true, why: "ship it" })).toEqual({ landId: "L1" });
    expect(last(based)).toMatchObject({ type: "land.requested", landId: "L1", final: true, why: "ship it" });
    expect(await call(based, "land", { why: "checkpoint" })).toEqual({ landId: "L2" });
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectTool } from "../../src/domain/role-tools.ts";
import { callArchitectTool, type ToolCaller } from "../../src/services/architect-tools.ts";
import { ledgerTasks } from "../../src/services/ledger-store.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());

const ARCHITECT: ToolCaller = { name: "architect-1", role: "architect" };
const WORKER: ToolCaller = { name: "T1", role: "worker" };

async function architectRun(engine: "architect" | "2.0" = "architect"): Promise<Run> {
  const { run } = freshRun();
  await appendEvent(run, { type: "run.started", ...startedFields, engine });
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
      foreign: [],
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

  it("capabilities names each role's rungs, the slots and the budget; a 2.0 run has none of these tools", async () => {
    const run = await architectRun();
    expect(await call(run, "capabilities", {})).toMatchObject({
      roles: { worker: { default: "codex:gpt-6-luna#high" }, researcher: expect.anything() },
      writers: { running: 0, cap: 4 },
      standing: { running: 0, cap: 4 },
      queued: 0,
    });
    const old = await architectRun("2.0");
    await expect(call(old, "capabilities", {})).rejects.toMatchObject({ code: "E_ROLE_SCOPE" });
  });
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEventInput } from "../src/domain/run-events.ts";
import type { Role } from "../src/domain/roles.ts";
import { db, insertCheck } from "../src/infra/db.ts";
import { writeLedger } from "../src/services/ledger-store.ts";
import type { Deps } from "../src/services/ports.ts";
import { runStart } from "../src/services/run-client.ts";
import { appendEvent } from "../src/services/run-events-store.ts";
import { appendRecord, findRun } from "../src/services/run-store.ts";
import { makeRecord } from "./domain/make-record.ts";

const START = Date.parse("2026-10-01T10:00:00.000Z");
const at = (minute: number) => new Date(START + minute * 60_000);
const rung = "codex:gpt-6-sol#high";
const nextRung = "codex:gpt-6-astra#high";

/** A completed architect run made entirely through the same stores as a real run. */
export async function seedFlowRun(deps: Deps, repo: string): Promise<{ id: string }> {
  const started = await runStart(
    { ...deps, now: () => START },
    { repo, title: "flow acceptance", aLines: ["A1 flow works"] },
  );
  const run = findRun(started.run);
  const add = (minute: number, e: RunEventInput) => appendEvent(run, e, at(minute));
  writeLedger(
    run,
    {
      tasks: {
        add: [
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `L${i + 1}`,
            goal: `Flow task ${i + 1}`,
            ...(i ? { depends: [`L${i}`] } : {}),
          })),
          // A representative long id and goal: the row must truncate on one line and keep the goal in its tooltip
          // and the drawer, while the header and sidebar count it like the rest.
          {
            id: "L9-a-long-ledger-task-id-that-truncates",
            goal: "Check that a long ledger task id truncates on one line and its full goal stays in the tooltip and the drawer",
            depends: ["L8"],
          },
        ],
        set: [{ id: "L7", state: "blocked" }],
      },
    },
    at(1),
  );
  const starts = new Map<string, { minute: number; role: Role; model: string }>();
  const start = async (minute: number, id: string, name: string, role: Role, model = rung) => (
    starts.set(id, { minute, role, model }),
    add(minute, {
      type: "dispatch.started",
      dispatchId: id,
      name,
      role,
      unit: name,
      lane: null,
      rung: model,
      thread: null,
    })
  );
  const end = async (
    minute: number,
    id: string,
    name: string,
    status: "ok" | "limit" | "cancelled" = "ok",
  ) => {
    const startInfo = starts.get(id)!;
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: id,
        name,
        role: startInfo.role,
        lane: null,
        rung: startInfo.model,
        status,
        replyStatus: status === "ok" ? "complete" : null,
        startedAt: at(startInfo.minute).toISOString(),
        endedAt: at(minute).toISOString(),
        secs: (minute - startInfo.minute) * 60,
        costUsd: 0.25,
      }),
    );
    return add(minute, {
      type: "dispatch.ended",
      dispatchId: id,
      name,
      unit: name,
      status,
      replyStatus: status === "ok" ? "complete" : null,
      reason: null,
      why: `${name} finished`,
      thread: null,
      head: null,
      environment: null,
      verdict: null,
      findings: [],
      replyPath: `roles/${name}/${id}/reply.md`,
    });
  };
  const delegate = async (
    minute: number,
    taskId: string,
    role: Role,
    ledgerTask: string | null,
    model = rung,
  ) =>
    add(minute, {
      type: "task.delegated",
      taskId,
      role,
      rung: model,
      thread: null,
      ledgerTask,
      by: "architect-1",
      why: `Delegate ${taskId} for flow`,
    });
  await start(1, "D001", "architect-1", "architect");
  await add(2, {
    type: "ledger.changed",
    tasks: ["L1", "L2"],
    progress: false,
    by: "architect-1",
    why: "Plan the flow tasks",
  });
  await delegate(3, "T1", "worker", "L1");
  await delegate(3, "T2", "writer", "L2");
  await delegate(3, "T3", "researcher", "L3");
  await delegate(3, "T4", "reviewer", "L4");
  await delegate(3, "T5", "verifier", "L5");
  await delegate(3, "T6", "artist", null);
  await end(4, "D001", "architect-1");
  for (const [i, role] of (
    ["worker", "writer", "researcher", "reviewer", "verifier", "artist"] as Role[]
  ).entries())
    await start(5 + i, `D00${i + 2}`, `T${i + 1}`, role);
  await end(12, "D002", "T1", "limit");
  for (let i = 2; i <= 6; i++) await end(12 + i, `D00${i + 1}`, `T${i}`, i === 4 ? "cancelled" : "ok");
  await add(19, {
    type: "question.parked",
    unit: "run",
    question: "Which direction should we take?",
    reason: "owner",
  });
  await add(22, { type: "question.answered", unit: "run", answer: "Continue", by: "owner" });
  // A limit that lands while no other role works: the hold from the 12-minute limit closes at 14 (a live role
  // masks its whole span), so this one is what puts a real quota interval in the derived idle row.
  await delegate(23, "T8", "worker", "L6");
  await start(23, "D010", "T8", "worker");
  await end(24, "D010", "T8", "limit");
  await start(25, "D008", "architect-2", "architect", nextRung);
  await add(26, {
    type: "task.delegated",
    taskId: "T7",
    role: "worker",
    rung: nextRung,
    thread: null,
    ledgerTask: "L1",
    by: "architect-2",
    why: "Retry the worker",
  });
  await add(27, {
    type: "check.requested",
    checkId: "C1",
    command: "bun test",
    scope: "full",
    base: false,
    fresh: true,
    by: "architect-2",
    why: "Check the complete run",
  });
  await end(28, "D008", "architect-2");
  await start(29, "D009", "T7", "worker", nextRung);
  await end(32, "D009", "T7");
  await add(33, {
    type: "ledger.changed",
    tasks: ["L1", "L2", "L6"],
    progress: true,
    by: "architect-2",
    why: "Record the finished and blocked tasks",
  });
  // Several ledger states, so the header and sidebar counts and the row chips cover more than `todo` and `blocked`.
  writeLedger(
    run,
    {
      tasks: {
        set: [
          { id: "L1", state: "done" },
          { id: "L2", state: "done" },
          { id: "L6", state: "blocked" },
        ],
      },
    },
    at(33),
  );
  const checks = [
    {
      id: "C1",
      request: 27,
      done: 36,
      command: "bun test",
      scope: "full" as const,
      base: false,
      cached: false,
      exit: 1,
      failures: ["new failure", "inherited failure"],
      preExisting: ["inherited failure"],
      verdict: "new" as const,
    },
    {
      id: "C2",
      request: 37,
      done: 39,
      command: "bun run lint",
      scope: "fast" as const,
      base: true,
      cached: false,
      exit: 0,
      failures: [],
      preExisting: [],
      verdict: "pass" as const,
    },
    {
      id: "C3",
      request: 40,
      done: 41,
      command: "bun run typecheck",
      scope: "fast" as const,
      base: false,
      cached: true,
      exit: 0,
      failures: [],
      preExisting: [],
      verdict: "pass" as const,
    },
  ];
  for (const c of checks) {
    if (c.id !== "C1")
      await add(c.request, {
        type: "check.requested",
        checkId: c.id,
        command: c.command,
        scope: c.scope,
        base: c.base,
        fresh: !c.cached,
        by: "architect-2",
        why: `Run ${c.command}`,
      });
    await add(c.done, {
      type: "check.done",
      checkId: c.id,
      exit: c.exit,
      failures: c.failures,
      preExisting: c.preExisting,
      cached: c.cached,
      verdict: c.verdict,
      minutes: c.done - c.request,
      logPath: `scratch/${c.id}.log`,
    });
    insertCheck(db(), run.id, {
      checkId: c.id,
      scope: c.scope,
      ref: "HEAD",
      tree: null,
      command: c.command,
      base: c.base,
      exit: c.exit,
      failures: c.failures,
      minutes: c.done - c.request,
      cached: c.cached,
      at: at(c.done).toISOString(),
      verdict: c.verdict,
    });
  }
  writeFileSync(join(run.dir, "report.md"), "# Flow acceptance\n\nThe seeded run is complete.\n");
  await add(45, { type: "run.ended", outcome: "done", reportPath: "report.md" });
  return { id: run.id };
}

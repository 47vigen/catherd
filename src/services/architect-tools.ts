import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type ArchTask,
  authorRung,
  crossFamilyRung,
  isStanding,
  ladderRung,
  REVIEW_ROUNDS,
  reviewRounds,
  STANDING_CAP,
  stalled,
  taskAttempts,
  WRITER_CAP,
  workAttempts,
} from "../domain/architect-state.ts";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { headlessRung, ID_PATTERN, modelFamily } from "../domain/ids.ts";
import { LedgerPatchSchema } from "../domain/ledger.ts";
import { type ArchitectTool, DELEGATOR_TOOLS } from "../domain/role-tools.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { HANDLINGS, RUN_UNIT, type RunEventInput } from "../domain/run-events.ts";
import type { RunState } from "../domain/run-state.ts";
import { snapshotTree } from "../infra/git.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { researchFile, taskBriefFile } from "./architect-run.ts";
import { budgetOf } from "./budget.ts";
import { cancel } from "./dispatch-service.ts";
import { ledgerTasks, renderLedger, writeLedger } from "./ledger-store.ts";
import type { Deps } from "./ports.ts";
import { isEarlierRun, replayRun, withEventsLock } from "./run-events-store.ts";
import { runProfile } from "./run-pin.ts";
import { readRecords, type Run } from "./run-store.ts";
import { MESSAGE_KINDS, teamRead, teamSend } from "./team.ts";
import { runTree } from "./tree-path.ts";

/**
 * Plan 47, spec D3 and D12: the architect's tools on the architect engine. Each one only reads the run or appends the
 * event that asks the daemon for something, with the caller's one-line `why`; the daemon does the rest. The same
 * functions serve the role server and `catherd call`. Ported from T3 Code's orchestrator tools (MIT,
 * github.com/pingdotgg/t3code, THIRD_PARTY_NOTICES.md); not synced.
 */
export interface ToolCaller {
  /** the dispatch name (`architect-3`, `T4`), or `owner` outside a role */
  name: string;
  role: Role;
}

export interface ToolContext {
  deps: Deps;
  run: Run;
  caller: ToolCaller;
  /** thread_wait's poll interval; tests shorten it */
  pollMs?: number;
}

const SUMMARY_CHARS = 2_000;
/** Spec O6: the only questions the architect may put to the owner. */
export const STOP_CLASSES = ["production", "secrets", "irreversible", "stuck"] as const;
/** The roles a task may be: every role but the architect itself. */
const TASK_ROLES = ROLES.filter((r) => r !== "architect") as [Role, ...Role[]];

const why = z
  .string()
  .min(1)
  .max(300)
  .describe("one line: why you call this; it goes into the run's change log");
const taskId = z.string().regex(/^T\d+$/, "a task id like T3");

const invalid = (message: string, fix: string): CatherdError =>
  new CatherdError("E_INPUT_INVALID", message, { fix });

const isArchitect = (c: ToolCaller): boolean => c.role === "architect" || c.name === "owner";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

function taskOf(c: ToolContext, s: RunState, id: string): ArchTask {
  const t = s.arch?.tasks[id];
  if (!t) throw invalid(`run ${c.run.id} has no task ${id}`, "capabilities and your digest list the tasks");
  // a worker sees only the standing-role tasks it delegated itself (D12)
  if (!isArchitect(c.caller) && t.by !== c.caller.name)
    throw new CatherdError("E_ROLE_SCOPE", `${id} was not delegated by ${c.caller.name}`, {
      fix: "ask about your own tasks only",
    });
  return t;
}

const workState = (t: ArchTask): "working" | "waiting" | "stopped" | "done" =>
  t.state === "queued"
    ? "waiting"
    : t.state === "working"
      ? "working"
      : t.state === "ended" && t.outcome?.startsWith("ok/")
        ? "done"
        : "stopped";

const at = (c: ToolContext): Date => new Date(c.deps.now());

/** A role's ladder default (spec D7): its `defaultRung`, else its first rung. */
const defaultOf = (rc: { rungs: string[]; defaultRung?: string }): string =>
  headlessRung(rc.defaultRung ?? (rc.rungs[0] as string));

/** Starts one task: its brief file, then `task.delegated` with the next free id, under the events lock. */
async function delegate(
  c: ToolContext,
  i: { role: Role; task: string; rung?: string; ledgerTask?: string; thread?: string | null; why: string },
): Promise<{
  taskId: string;
  rung: string;
  sameFamily: boolean;
  thread: string | null;
  reportPath: string | null;
}> {
  if (!isArchitect(c.caller) && !isStanding(i.role))
    throw new CatherdError(
      "E_ROLE_SCOPE",
      `a ${c.caller.role} delegates only to the researcher or the writer`,
      {
        fix: "ask the architect for anything else: team_send to architect",
      },
    );
  const rc = runProfile(c.deps, c.run).roles[i.role];
  if (!rc?.enabled || rc.rungs.length === 0)
    throw invalid(`the ${i.role} role is off or has no rung`, "capabilities lists the roles you can use");
  const ladder = rc.rungs.map(headlessRung);
  if (i.rung !== undefined && !ladder.includes(headlessRung(i.rung)))
    throw invalid(`${i.rung} is not on the ${i.role} ladder`, `use one of ${ladder.join(", ")}, or none`);
  if (i.ledgerTask !== undefined) {
    if (!ledgerTasks(c.run).some((t) => t.id === i.ledgerTask))
      throw invalid(`the ledger has no task ${i.ledgerTask}`, "add it with ledger first");
  }
  const review = i.role === "reviewer";
  // plan 51: the tree a review reads, so the next review of the same ledger task reads only what changed since
  const snapshot = review ? await reviewSnapshot(c.run) : null;
  let rung = "";
  let sameFamily = false;
  const id = await withEventsLock(c.run, (add) => {
    const s = replayRun(c.run);
    // spec D7: no rung is the ladder's default, or one step up after a rung failure on this ledger task
    rung =
      i.rung === undefined
        ? ladderRung(s.arch, i.role, i.ledgerTask ?? null, ladder, defaultOf(rc))
        : headlessRung(i.rung);
    if (review) {
      // spec D8: a review runs on another model family than the work it reads, and says so when it cannot
      const author = authorRung(s.arch, i.ledgerTask ?? null);
      if (i.rung === undefined) ({ rung, sameFamily } = crossFamilyRung(ladder, rung, author));
      else sameFamily = author !== null && modelFamily(author) === modelFamily(rung);
    }
    if (i.ledgerTask !== undefined && review) {
      const rounds = reviewRounds(s.arch, i.ledgerTask).length;
      if (rounds >= REVIEW_ROUNDS)
        throw invalid(
          `ledger task ${i.ledgerTask} has had ${rounds} review rounds since you last changed it`,
          `replan it: rewrite its goal or split it with ledger, then review the new approach`,
        );
    } else if (i.ledgerTask !== undefined && i.role !== "verifier" && i.role !== "researcher") {
      // spec D10: a ledger task's attempts cap, and no same-rung retry without new information
      const cap = s.caps.attempts;
      if (workAttempts(s.arch, i.ledgerTask).length >= cap)
        throw invalid(
          `ledger task ${i.ledgerTask} has had its ${cap} attempts`,
          `replan or split it, ask the owner, or set it impossible with ledger`,
        );
      const last = stalled(s, i.ledgerTask, rung);
      if (last)
        throw invalid(
          `stalled: ${last.taskId} on ${i.ledgerTask} ended ${last.outcome} on ${rung}, and nothing new came in since`,
          `change the rung, edit the ledger with what you learned, ask the owner, or set ${i.ledgerTask} impossible`,
        );
    }
    const id = `T${Object.keys(s.arch?.tasks ?? {}).length + 1}`;
    writeTextAtomic(join(c.run.dir, taskBriefFile(id)), `${i.task.trim()}\n`);
    add(
      {
        type: "task.delegated",
        taskId: id,
        role: i.role,
        rung,
        thread: i.thread ?? null,
        ledgerTask: i.ledgerTask ?? null,
        by: c.caller.name,
        why: i.why,
        ...(sameFamily ? { sameFamily: true as const } : {}),
        ...(snapshot ? { snapshot } : {}),
      },
      at(c),
    );
    return id;
  });
  return {
    taskId: id,
    rung,
    sameFamily,
    thread: i.thread ?? null,
    reportPath: i.role === "researcher" ? researchFile(id) : null,
  };
}

/** The tree a review reads, as a commit no ref holds; null before a base run's tree exists or on a git failure. */
async function reviewSnapshot(run: Run): Promise<string | null> {
  let tree: string;
  try {
    tree = runTree(run);
  } catch {
    return null;
  }
  return snapshotTree(tree);
}

/** Appends one event under the events lock. */
const append = (c: ToolContext, e: RunEventInput): Promise<unknown> =>
  withEventsLock(c.run, (add) => add(e, at(c)));

export interface ToolSpec {
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  call(c: ToolContext, a: never): unknown;
}

const spec = <S extends z.ZodRawShape>(
  description: string,
  shape: S,
  readOnly: boolean,
  call: (c: ToolContext, a: z.infer<z.ZodObject<S>>) => unknown,
): ToolSpec => ({ description, shape, readOnly, call: call as (c: ToolContext, a: never) => unknown });

export const ARCHITECT_TOOL_SPECS: Record<ArchitectTool, ToolSpec> = {
  capabilities: spec(
    "The roles you can delegate to, each with its ladder (its rungs, lowest first) and the ladder's default, the quota holds, the budget, and the free writer and standing-role slots. Read-only.",
    {},
    true,
    (c) => {
      const s = replayRun(c.run);
      const profile = runProfile(c.deps, c.run);
      const working = Object.values(s.arch?.tasks ?? {}).filter((t) => t.state === "working");
      const standing = working.filter((t) => isStanding(t.role)).length;
      return {
        roles: Object.fromEntries(
          TASK_ROLES.flatMap((r) => {
            const rc = profile.roles[r];
            return rc?.enabled && rc.rungs.length
              ? [[r, { ladder: rc.rungs.map(headlessRung), default: defaultOf(rc) }]]
              : [];
          }),
        ),
        holds: s.holds,
        writers: { running: working.length - standing, cap: WRITER_CAP },
        standing: { running: standing, cap: STANDING_CAP },
        queued: Object.values(s.arch?.tasks ?? {}).filter((t) => t.state === "queued").length,
        budget: budgetOf(c.run, profile.budget, c.deps.now()),
      };
    },
  ),
  delegate_task: spec(
    "Start one task with only `task` as its brief (catherd adds the role's contract). rung: any rung on the role's ladder. No rung: the ladder's default, or for a ledger task the rung its last attempt ran on, one step up when that attempt failed, timed out, was too hard, or a review of it found an IMPORTANT finding. A reviewer with no rung runs on the first rung of another model family than the work it reads (sameFamily: true when its ladder has none); a reviewer on a ledger task with three review rounds since your last edit of it is refused: replan it. It returns at once with the rung; the task's end wakes you. A worker or a writer may delegate only to the researcher or the writer.",
    {
      role: z.enum(TASK_ROLES),
      task: z.string().min(1),
      rung: z.string().optional(),
      ledgerTask: z.string().regex(ID_PATTERN).optional(),
      why,
    },
    false,
    (c, a) => delegate(c, a),
  ),
  task_status: spec(
    "A task's state (working, waiting, stopped, done), its reply's summary, its report path, the files it changed with why, its stop reason and cost. Reading a finished task marks it delivered.",
    { taskId },
    false,
    async (c, a) => {
      const s = replayRun(c.run);
      const t = taskOf(c, s, a.taskId);
      const record = t.dispatchId
        ? readRecords(c.run).records.find((r) => r.dispatchId === t.dispatchId)
        : undefined;
      const reply = record?.replyPath ? read(join(c.run.dir, record.replyPath)) : "";
      const state = workState(t);
      if ((state === "done" || state === "stopped") && !t.read && isArchitect(c.caller))
        await append(c, { type: "task.read", taskId: t.taskId });
      const extras = record?.extras ?? [];
      return {
        taskId: t.taskId,
        role: t.role,
        rung: t.rung,
        workState: state,
        summary: reply.length > SUMMARY_CHARS ? `${reply.slice(0, SUMMARY_CHARS)}…` : reply,
        reportPath: t.role === "researcher" ? researchFile(t.taskId) : (record?.replyPath ?? null),
        changed: [
          ...extras,
          ...[...new Set([...(record?.changedOwned ?? []), ...(record?.violations ?? [])])]
            .filter((p) => !extras.some((e) => e.path === p))
            .map((p) => ({ path: p, why: "" })),
        ],
        stopReason:
          t.state === "ended" ? t.outcome : t.state === "queued" || t.state === "working" ? null : t.state,
        costUsd: record?.costUsd ?? null,
        ...(t.role === "reviewer"
          ? {
              sameFamily: t.sameFamily,
              findings: t.findings.map((f, n) => ({
                n: n + 1,
                severity: f.label,
                class: f.class ?? null,
                text: f.text,
                handled: t.handled[n + 1] ?? null,
              })),
            }
          : {}),
      };
    },
  ),
  task_cancel: spec(
    "Stop a task. A queued one never starts; a running one is stopped with its children; a finished one keeps its result.",
    { taskId, why },
    false,
    async (c, a) => {
      const t = taskOf(c, replayRun(c.run), a.taskId);
      if (t.state !== "queued" && t.state !== "working") return { taskId: t.taskId, workState: workState(t) };
      await append(c, { type: "task.cancelled", taskId: t.taskId, by: c.caller.name, why: a.why });
      if (t.state === "working")
        try {
          await cancel(c.deps, c.run.id, t.taskId);
        } catch (e) {
          if (!(isCatherdError(e) && e.code === "E_RUN_NOT_LIVE")) throw e;
        }
      return { taskId: t.taskId, workState: "stopped" };
    },
  ),
  thread_send: spec(
    "Send a message to a task (T3), a role (worker) or all. auto steers a running task where its backend allows, else queues it for its next turn; queue never steers. To a finished task, it resumes that task's thread as a new task and returns its id.",
    {
      to: z.string().min(1),
      text: z.string().min(1),
      mode: z.enum(["auto", "queue", "steer"]).optional(),
      kind: z.enum(MESSAGE_KINDS).optional(),
      why,
    },
    false,
    async (c, a) => {
      const s = replayRun(c.run);
      const t = s.arch?.tasks[a.to];
      const thread = t?.dispatchId ? (s.dispatches[t.dispatchId]?.thread ?? null) : null;
      if (t && (t.state === "ended" || t.state === "cancelled") && thread) {
        const resumed = await delegate(c, {
          role: t.role,
          task: a.text,
          rung: t.rung,
          ...(t.ledgerTask ? { ledgerTask: t.ledgerTask } : {}),
          thread,
          why: a.why,
        });
        await append(c, {
          type: "thread.sent",
          to: a.to,
          n: 0,
          delivery: "resumed",
          by: c.caller.name,
          why: a.why,
        });
        return { ...resumed, delivery: "resumed" };
      }
      const sent = await teamSend({
        run: c.run.id,
        from: c.caller.name,
        to: a.to,
        text: a.text,
        ...(a.kind ? { kind: a.kind } : {}),
        // steer is auto that never falls back silently: the delivery says what happened
        ...(a.mode === "queue" ? { mode: "queue" as const } : {}),
      });
      await append(c, {
        type: "thread.sent",
        to: a.to,
        n: sent.n,
        delivery: sent.delivery,
        by: c.caller.name,
        why: a.why,
      });
      return sent;
    },
  ),
  thread_read: spec(
    "Read the run's team channel, a small page at a time: from a sender, since a message number (page with since=next).",
    {
      from: z.string().optional(),
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(20).optional(),
      maxChars: z.number().int().min(1).max(2000).optional(),
    },
    true,
    (c, a) => teamRead({ run: c.run.id, ...a }),
  ),
  thread_wait: spec(
    "Wait until one of these tasks stops working, at most timeoutSec (300). Only for a short join inside a turn: by default end your turn, and a task's end wakes you.",
    { taskIds: z.array(taskId).min(1), timeoutSec: z.number().int().min(0).max(300).optional() },
    true,
    async (c, a) => {
      const deadline = Date.now() + (a.timeoutSec ?? 60) * 1000;
      for (;;) {
        const s = replayRun(c.run);
        for (const id of a.taskIds) {
          const t = taskOf(c, s, id);
          if (t.state !== "queued" && t.state !== "working")
            return { taskId: id, workState: workState(t), timedOut: false };
        }
        if (Date.now() >= deadline) return { taskId: null, workState: null, timedOut: true };
        await Bun.sleep(c.pollMs ?? 1_000);
      }
    },
  ),
  check: spec(
    "Run a check command on the run's tree as it stands (base: true, on the run's start commit) under the machine's heavy lock. It returns at once with the check id; the result wakes you. A pass on an unchanged tree is reused unless fresh: true; nothing is rerun on its own.",
    {
      command: z.string().min(1),
      scope: z.enum(["fast", "full"]).optional(),
      base: z.boolean().optional(),
      fresh: z.boolean().optional(),
      why,
    },
    false,
    async (c, a) => {
      const checkId = await withEventsLock(c.run, (add) => {
        const id = `C${Object.keys(replayRun(c.run).arch?.checks ?? {}).length + 1}`;
        add(
          {
            type: "check.requested",
            checkId: id,
            command: a.command,
            scope: a.scope ?? "full",
            base: a.base ?? false,
            fresh: a.fresh ?? false,
            by: c.caller.name,
            why: a.why,
          },
          at(c),
        );
        return id;
      });
      return { checkId };
    },
  ),
  ledger: spec(
    "Edit your ledger: tasks adds, sets and removes ledger tasks (id, goal, depends, oracle, state); progress appends this turn's entry, what you did and why. catherd renders them as ledger/tasks.json and ledger/progress.md.",
    { tasks: LedgerPatchSchema.optional(), progress: z.string().optional(), why },
    false,
    async (c, a) => {
      const tasks = writeLedger(
        c.run,
        { ...(a.tasks ? { tasks: a.tasks } : {}), ...(a.progress ? { progress: a.progress } : {}) },
        at(c),
      );
      const touched = [
        ...(a.tasks?.add ?? []).map((t) => t.id),
        ...(a.tasks?.set ?? []).map((t) => t.id),
        ...(a.tasks?.remove ?? []),
      ];
      await append(c, {
        type: "ledger.changed",
        tasks: touched,
        progress: !!a.progress?.trim(),
        by: c.caller.name,
        why: a.why,
      });
      const arch = replayRun(c.run).arch;
      renderLedger(c.run, arch ? taskAttempts(arch) : []);
      return { tasks: tasks.length };
    },
  ),
  findings: spec(
    "Log what you did with a review's findings, numbered as task_status lists them: fix, rejected, intentional, not-worth-it, or known-issue (the merge request lists it under Known issues; a PRE-EXISTING finding is listed there without this). missed: a bug a review of that ledger task did not report and a check, the verifier, the owner or a later review caught; it joins the reviewer eval set.",
    {
      taskId: taskId.optional(),
      handled: z.array(z.object({ n: z.number().int().min(1), as: z.enum(HANDLINGS) })).optional(),
      missed: z
        .object({
          ledgerTask: z.string().regex(ID_PATTERN),
          bug: z.string().min(1),
          caughtBy: z.enum(["check", "verifier", "owner", "review"]),
          review: taskId.optional(),
        })
        .optional(),
      why,
    },
    false,
    async (c, a) => {
      if (!a.handled && !a.missed)
        throw invalid("findings: nothing to log", "pass handled with taskId, or missed");
      const s = replayRun(c.run);
      if (a.handled) {
        if (!a.taskId) throw invalid("handled needs the review's taskId", "pass taskId");
        const t = taskOf(c, s, a.taskId);
        const over = a.handled.find((h) => h.n > t.findings.length);
        if (t.role !== "reviewer" || over)
          throw invalid(
            `${t.taskId} has no finding ${over?.n ?? 1}`,
            "task_status lists a review's findings by number",
          );
        await append(c, {
          type: "findings.handled",
          taskId: t.taskId,
          handled: a.handled,
          by: c.caller.name,
          why: a.why,
        });
      }
      if (a.missed) {
        if (!ledgerTasks(c.run).some((t) => t.id === a.missed?.ledgerTask))
          throw invalid(`the ledger has no task ${a.missed.ledgerTask}`, "name a ledger task");
        if (a.missed.review && s.arch.tasks[a.missed.review]?.role !== "reviewer")
          throw invalid(
            `${a.missed.review} is not a review of this run`,
            "name the review's taskId, or omit it",
          );
        await append(c, {
          type: "review.missed",
          ledgerTask: a.missed.ledgerTask,
          review: a.missed.review ?? null,
          bug: a.missed.bug,
          caughtBy: a.missed.caughtBy,
          by: c.caller.name,
          why: a.why,
        });
      }
      return { logged: true };
    },
  ),
  land: spec(
    "Land the run (a base run only): commit what its tree holds, push its branch (never forced, never the base) and open or update its merge request. final: true also needs a green full check (check scope: full) and a verifier PASS on the pushed commit; it fetches the base first, merging it when it moved under the run's files, and then asks the owner one question: merge? The owner's answer ends the run done. It returns at once; the result wakes you.",
    { final: z.boolean().optional(), why },
    false,
    async (c, a) => {
      if (!c.run.meta.base)
        throw invalid(
          `run ${c.run.id} has no base: it works in the repository's checkout`,
          "commit and push it yourself, or start the run with base",
        );
      const landId = await withEventsLock(c.run, (add) => {
        const id = `L${Object.keys(replayRun(c.run).arch?.lands ?? {}).length + 1}`;
        add(
          { type: "land.requested", landId: id, final: a.final ?? false, by: c.caller.name, why: a.why },
          at(c),
        );
        return id;
      });
      return { landId };
    },
  ),
  ask_owner: spec(
    "Ask the owner one question, only in a stop class: production, secrets, an irreversible action outside the repository, or a stuck or impossible run. Put the run, the options and your recommendation first in the question. Only that scope waits; the answer wakes you.",
    {
      question: z.string().min(1),
      options: z.array(z.string().min(1)).optional(),
      scope: z.string().regex(/^(run|task:T\d+)$/, "run, or task:<id>"),
      stopClass: z.enum(STOP_CLASSES),
      why,
    },
    false,
    async (c, a) => {
      const unit = a.scope === "run" ? RUN_UNIT : a.scope.slice("task:".length);
      if (replayRun(c.run).questions[unit])
        throw invalid(`${unit} already waits for the owner`, "wait for the answer; it wakes you");
      const question = [`(${a.stopClass}) ${a.question}`, ...(a.options ?? []).map((o) => `- ${o}`)].join(
        "\n",
      );
      await append(c, { type: "question.parked", unit, question, reason: "owner", why: a.why });
      return { unit, parked: true };
    },
  ),
  finish: spec(
    "End the run: done, impossible or stopped, with why. catherd stops the tasks still running and writes the report.",
    { verdict: z.enum(["done", "impossible", "stopped"]), why },
    false,
    async (c, a) => {
      await append(c, { type: "run.finishing", verdict: a.verdict, by: c.caller.name, why: a.why });
      return { finishing: a.verdict };
    },
  ),
};

/** The tools a role has on the architect engine: all for the architect, the standing-role three for a writer. */
export const architectToolsFor = (role: Role): readonly ArchitectTool[] =>
  role === "architect"
    ? (Object.keys(ARCHITECT_TOOL_SPECS) as ArchitectTool[])
    : role === "worker" || role === "writer"
      ? DELEGATOR_TOOLS
      : [];

/** One call: refused outside an architect run or the caller's tools, its arguments validated, then run. */
export async function callArchitectTool(
  c: ToolContext,
  tool: ArchitectTool,
  args: unknown,
): Promise<unknown> {
  if (isEarlierRun(c.run))
    throw new CatherdError(
      "E_ROLE_SCOPE",
      `run ${c.run.id} was started by an earlier catherd: ${tool} is not here`,
      {
        fix: "finish it with the catherd that started it",
      },
    );
  if (c.caller.name !== "owner" && !architectToolsFor(c.caller.role).includes(tool))
    throw new CatherdError("E_ROLE_SCOPE", `a ${c.caller.role} has no ${tool}`, {
      fix: "report it in your reply, or ask the architect",
    });
  const spec = ARCHITECT_TOOL_SPECS[tool];
  const parsed = z.object(spec.shape).safeParse(args ?? {});
  if (!parsed.success)
    throw invalid(
      `${tool}: ${z.prettifyError(parsed.error).replace(/\n\s*/g, " ")}`,
      `see ${tool}'s input schema`,
    );
  return await spec.call(c, parsed.data as never);
}

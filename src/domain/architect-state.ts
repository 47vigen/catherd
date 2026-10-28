import { quotaOf } from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import type { TaskAttempt } from "./ledger.ts";
import type { Role } from "./roles.ts";
import { RUN_UNIT, type RunEvent } from "./run-events.ts";
import { HOLD_MS, liveDispatches, type RunState, recomputeWake } from "./run-state.ts";

/**
 * Spec D1–D3, D12: the state of a run on the architect engine. The architect is woken by events, delegates tasks
 * through its tools, and keeps its memory in the ledger; this is what the daemon needs to start what it asked for
 * and to wake it again. Pure: `applyArchitect` folds one event into `s.arch` (and the dispatch table it shares
 * with the 2.0 machine).
 */
export const STANDING_ROLES: readonly Role[] = ["researcher", "writer"];
export const isStanding = (role: Role): boolean => STANDING_ROLES.includes(role);
/** Spec D12: standing-role tasks at once, outside the writer cap. */
export const STANDING_CAP = 4;
/** Spec D1: every other delegated task; memory-bound per-writer caps come with per-writer trees (stage 2). */
export const WRITER_CAP = 4;
/** An architect that failed or could not start this many turns in a row stops the run. */
export const FAILED_TURNS_MAX = 3;

export const architectName = (turn: number): string => `architect-${turn}`;

export interface ArchTask {
  taskId: string;
  role: Role;
  rung: string;
  /** the thread a follow-up resumes (thread_send to a finished task), else null */
  thread: string | null;
  ledgerTask: string | null;
  /** the dispatch name of the caller: an architect turn, or a worker for a standing role */
  by: string;
  why: string;
  state: "queued" | "working" | "ended" | "cancelled" | "refused";
  dispatchId: string | null;
  /** `status/replyStatus` once it ended */
  outcome: string | null;
  /** the architect read its result with task_status */
  read: boolean;
}

export interface ArchCheck {
  checkId: string;
  command: string;
  scope: "fast" | "full";
  base: boolean;
  fresh: boolean;
  state: "queued" | "done";
}

/** One line of the next turn's digest; `wakes` false rides along without waking the architect. */
export interface InboxItem {
  seq: number;
  text: string;
  wakes: boolean;
  taskId?: string;
}

export type FinishVerdict = "done" | "impossible" | "stopped";

export interface ArchState {
  tasks: Record<string, ArchTask>;
  checks: Record<string, ArchCheck>;
  inbox: InboxItem[];
  /** architect turns started so far; the next is `architect-<turns + 1>` */
  turns: number;
  /** the running turn's dispatch id */
  turn: string | null;
  /** the architect's thread and the rung it runs on, from its last ended turn */
  thread: string | null;
  rung: string | null;
  /** why the next turn starts a fresh thread, else null (resume) */
  fresh: string | null;
  failedTurns: number;
  /** turns in a row that ended with nothing running, nothing queued and nothing asked */
  idle: number;
  finishing: { verdict: FinishVerdict; why: string } | null;
}

export function emptyArch(): ArchState {
  return {
    tasks: {},
    checks: {},
    inbox: [],
    turns: 0,
    turn: null,
    thread: null,
    rung: null,
    fresh: null,
    failedTurns: 0,
    idle: 0,
    finishing: null,
  };
}

/** The dispatches that worked a ledger task, for `ledger/tasks.json`. */
export const taskAttempts = (a: ArchState): TaskAttempt[] =>
  Object.values(a.tasks)
    .filter((t) => t.dispatchId !== null)
    .map((t) => ({
      taskId: t.taskId,
      ledgerTask: t.ledgerTask,
      rung: t.rung,
      working: t.state === "working",
      outcome: t.outcome,
    }));

const byArchitect = (by: string): boolean => by === "architect" || by.startsWith("architect-");

function push(a: ArchState, e: RunEvent, text: string, wakes = true, taskId?: string): void {
  a.inbox.push({ seq: e.seq, text, wakes, ...(taskId ? { taskId } : {}) });
}

function failTurn(a: ArchState, why: string): void {
  a.failedTurns += 1;
  a.fresh = why;
  if (a.failedTurns >= FAILED_TURNS_MAX)
    a.finishing ??= {
      verdict: "stopped",
      why: `the architect failed ${a.failedTurns} turns in a row: ${why}`,
    };
}

/** Nothing runs, nothing waits to start, nothing waits for the owner or a check, and no event is undelivered. */
function idleNow(s: RunState, a: ArchState): boolean {
  return (
    liveDispatches(s).length === 0 &&
    !Object.values(a.tasks).some((t) => t.state === "queued") &&
    !Object.values(a.checks).some((c) => c.state === "queued") &&
    !a.inbox.some((i) => i.wakes) &&
    Object.keys(s.questions).length === 0 &&
    a.finishing === null
  );
}

/**
 * Folds `e` into an architect run's state; false leaves the event to the 2.0 reducer (pause, cancel, questions
 * parked and reminded, reports, ticks, the run's end), whose handling of them is the same here.
 */
export function applyArchitect(s: RunState, e: RunEvent): boolean {
  const a = s.arch;
  if (!a) return false;
  switch (e.type) {
    case "daemon.started":
      if (a.thread !== null) a.fresh ??= "the daemon restarted";
      return true;
    case "dispatch.started": {
      s.dispatches[e.dispatchId] = {
        dispatchId: e.dispatchId,
        name: e.name,
        role: e.role,
        unit: e.unit,
        lane: e.lane,
        rung: e.rung,
        thread: e.thread,
        startedAt: e.at,
        ...(e.teamSeen === undefined ? {} : { teamSeen: e.teamSeen }),
        ended: null,
      };
      if (e.role === "architect") {
        a.turns += 1;
        a.turn = e.dispatchId;
        const upTo = e.upTo ?? e.seq;
        a.inbox = a.inbox.filter((i) => i.seq > upTo);
        a.fresh = null;
      } else {
        const t = a.tasks[e.name];
        if (t) {
          // a cancel that landed while the start was in flight keeps the task cancelled; the machine stops it
          if (t.state !== "cancelled") t.state = "working";
          t.dispatchId = e.dispatchId;
        }
      }
      recomputeWake(s);
      return true;
    }
    case "dispatch.refused": {
      if (e.code === "E_RUN_CANCELLED") return true;
      const t = a.tasks[e.name];
      if (t) {
        t.state = "refused";
        push(
          a,
          e,
          `${t.taskId} (${t.role}) could not start: ${e.code} ${e.message}`,
          byArchitect(t.by),
          t.taskId,
        );
      } else if (e.unit === RUN_UNIT) {
        failTurn(a, `your turn could not start: ${e.code}`);
        push(a, e, `your last turn could not start: ${e.code} ${e.message}`);
      }
      return true;
    }
    case "dispatch.ended": {
      const dv = s.dispatches[e.dispatchId];
      if (!dv) return true;
      dv.thread = e.thread ?? dv.thread;
      dv.ended = { at: e.at, status: e.status, replyStatus: e.replyStatus, reason: e.reason };
      const rung = tryParseRung(dv.rung);
      if (rung) {
        if (e.status === "limit") s.holds[quotaOf(rung)] = new Date(Date.parse(e.at) + HOLD_MS).toISOString();
        else if (e.status === "ok" && e.replyStatus === "complete") delete s.holds[quotaOf(rung)];
      }
      recomputeWake(s);
      if (dv.role === "architect") {
        if (a.turn === e.dispatchId) a.turn = null;
        a.thread = dv.thread;
        a.rung = dv.rung;
        if (e.status !== "ok") {
          failTurn(a, `your last turn ended ${e.status}`);
          push(a, e, `your last turn ended ${e.status}: ${e.why || "no reason given"}`);
          return true;
        }
        a.failedTurns = 0;
        if (!idleNow(s, a)) {
          a.idle = 0;
          return true;
        }
        a.idle += 1;
        if (a.idle >= 2)
          a.finishing = { verdict: "stopped", why: "idle: two turns in a row ended with nothing running" };
        else
          push(
            a,
            e,
            "idle: nothing is running, nothing is queued and nobody was asked. Delegate, check, ask the owner or finish.",
          );
        return true;
      }
      const t = a.tasks[e.name];
      if (!t) return true;
      t.state = "ended";
      t.outcome = `${e.status}/${e.replyStatus ?? "none"}`;
      const mine = byArchitect(t.by);
      push(
        a,
        e,
        mine
          ? `${t.taskId} (${t.role}${t.ledgerTask ? `, ledger ${t.ledgerTask}` : ""}) ended ${t.outcome}: ${e.why || "no reason given"}; reply ${e.replyPath}`
          : `${t.taskId} (${t.role}, for ${t.by}) ended ${t.outcome}; reply ${e.replyPath}`,
        mine,
        t.taskId,
      );
      return true;
    }
    case "task.delegated":
      a.tasks[e.taskId] = {
        taskId: e.taskId,
        role: e.role,
        rung: e.rung,
        thread: e.thread,
        ledgerTask: e.ledgerTask,
        by: e.by,
        why: e.why,
        state: "queued",
        dispatchId: null,
        outcome: null,
        read: false,
      };
      if (byArchitect(e.by)) a.idle = 0;
      else push(a, e, `${e.by} delegated ${e.taskId} to the ${e.role}: ${e.why}`, false, e.taskId);
      return true;
    case "task.cancelled": {
      const t = a.tasks[e.taskId];
      if (t?.state === "queued") t.state = "cancelled";
      a.idle = 0;
      return true;
    }
    case "task.read": {
      const t = a.tasks[e.taskId];
      if (t) t.read = true;
      a.inbox = a.inbox.filter((i) => i.taskId !== e.taskId);
      return true;
    }
    case "check.requested":
      a.checks[e.checkId] = {
        checkId: e.checkId,
        command: e.command,
        scope: e.scope,
        base: e.base,
        fresh: e.fresh,
        state: "queued",
      };
      a.idle = 0;
      return true;
    case "check.done": {
      const c = a.checks[e.checkId];
      if (c) c.state = "done";
      const result =
        e.exit === 0
          ? "passed"
          : `failed (exit ${e.exit ?? "timeout"}): ${e.failures.length} failing line(s), ${e.preExisting.length} also on the base`;
      push(
        a,
        e,
        `${e.checkId} (${c?.scope ?? "check"}${c?.base ? ", on the base" : ""}) ${result}${e.cached ? ", from a pass on the same tree" : ""}; log ${e.logPath}`,
      );
      return true;
    }
    case "ledger.changed":
    case "thread.sent":
      // writing progress or steering a thread is not work: the architect does both every turn
      return true;
    case "run.finishing":
      a.idle = 0;
      a.finishing ??= { verdict: e.verdict, why: e.why };
      return true;
    case "question.parked":
      a.idle = 0;
      return false;
    case "question.answered":
      delete s.questions[e.unit];
      recomputeWake(s);
      push(a, e, `the owner answered (${e.unit}): ${e.answer}`);
      return true;
    case "effect.failed": {
      if (e.action === "report" || e.action === "notify" || e.action === "remind") return true;
      if (e.action === "runCheck") {
        const c = a.checks[e.unit];
        if (c) c.state = "done";
      }
      if (e.action === "dispatch" && e.unit === RUN_UNIT)
        failTurn(a, `your turn could not start: ${e.message}`);
      const t = e.action === "dispatch" ? a.tasks[e.unit] : undefined;
      if (t?.state === "queued") t.state = "refused";
      push(a, e, `${e.action} on ${e.unit} failed: ${e.message}`);
      return true;
    }
    default:
      return false;
  }
}

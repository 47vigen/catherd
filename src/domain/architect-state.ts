import { CAP_GRACE_MS, CAP_WARN } from "./caps.ts";
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
  /** the seq of its `dispatch.ended`, for the stall rule */
  endedSeq: number | null;
  /** spec D7: it ended for a reason a stronger rung may fix (failed, timeout, too_hard, a review BLOCKER) */
  climbs: boolean;
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
  /** spec D10: how far the wall cap is spent: `warned` at 80%, `capped` at 100% (no new task starts) */
  wall: "ok" | "warned" | "capped";
  /** the last owner answer or check result: news for every ledger task */
  newsSeq: number;
  /** the last ledger edit that named each ledger task: news for that task only */
  ledgerNews: Record<string, number>;
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
    wall: "ok",
    newsSeq: 0,
    ledgerNews: {},
  };
}

const hours = (ms: number): string => `${Math.round((ms / 3_600_000) * 10) / 10} h`;

/** The run's time so far, every pause left out: what the wall cap counts. */
export function wallMs(s: RunState): number {
  if (s.startedAt === null) return 0;
  const open = s.paused === null ? 0 : Date.parse(s.at) - Date.parse(s.paused);
  return Date.parse(s.at) - Date.parse(s.startedAt) - s.pausedMs - open;
}

/** When the wall cap's next mark falls (80%, 100%, the grace's end), for the wake timer; null while paused. */
export function nextWallMark(s: RunState): string | null {
  const a = s.arch;
  if (s.startedAt === null || s.phase !== "running" || s.earlier || s.paused !== null || a.finishing)
    return null;
  const cap = s.caps.wallMin * 60_000;
  const mark = a.wall === "ok" ? cap * CAP_WARN : a.wall === "warned" ? cap : cap + CAP_GRACE_MS;
  return new Date(Date.parse(s.startedAt) + s.pausedMs + mark).toISOString();
}

/** Spec D10's wall cap, after every event: wake at 80%, stop new tasks at 100%, stop the run after the grace. */
export function checkWall(s: RunState, e: RunEvent): boolean {
  const a = s.arch;
  if (nextWallMark(s) === null) return false;
  const cap = s.caps.wallMin * 60_000;
  const spent = wallMs(s);
  const before = `${a.wall}/${a.finishing === null}`;
  if (a.wall === "ok" && spent >= cap * CAP_WARN) {
    a.wall = "warned";
    push(
      a,
      e,
      `cap: 80% of the run's wall time is spent (${hours(spent)} of ${hours(cap)}): plan to land what is done and finish.`,
    );
  }
  if (a.wall === "warned" && spent >= cap) {
    a.wall = "capped";
    push(
      a,
      e,
      `cap: the run's wall time (${hours(cap)}) is spent. No new task starts, and the run stops in ${CAP_GRACE_MS / 60_000} minutes: finish now.`,
    );
  }
  if (a.wall === "capped" && spent >= cap + CAP_GRACE_MS)
    a.finishing = { verdict: "stopped", why: `cap: the run's wall time (${hours(cap)}) is spent` };
  return `${a.wall}/${a.finishing === null}` !== before;
}

/** The dispatches a ledger task has had, a cancelled or refused one not counted. */
export const attemptsOn = (a: ArchState, ledgerTask: string): ArchTask[] =>
  Object.values(a.tasks).filter(
    (t) => t.ledgerTask === ledgerTask && t.state !== "cancelled" && t.state !== "refused",
  );

/** The attempt that ended last, by its `dispatch.ended` seq (parallel attempts end out of insertion order). */
const lastEnded = (tries: ArchTask[]): ArchTask | undefined =>
  tries
    .filter((t) => t.state === "ended" && t.endedSeq !== null)
    .reduce<ArchTask | undefined>(
      (a, t) => (!a || (t.endedSeq as number) > (a.endedSeq as number) ? t : a),
      undefined,
    );

/**
 * Spec D10's stall: the ledger task's last attempt ended short of complete, nothing new came in since (no edit of that ledger task,
 * owner answer or check result), and the next would run on the same rung. Returns that attempt, else null.
 */
export function stalled(s: RunState, ledgerTask: string, rung: string): ArchTask | null {
  const last = lastEnded(attemptsOn(s.arch, ledgerTask));
  // a quota end (`limit`) is transient, not a failure the same rung would repeat
  if (!last || last.endedSeq === null || last.outcome === "ok/complete" || last.outcome?.startsWith("limit/"))
    return null;
  const news = Math.max(s.arch.newsSeq, s.arch.ledgerNews[ledgerTask] ?? 0);
  return last.rung === rung && news < last.endedSeq ? last : null;
}

/** The roles whose BLOCKER finding climbs the ledger task's ladder (spec D7). */
const REVIEW_ROLES: readonly Role[] = ["reviewer", "ui-reviewer"];

/**
 * Spec D7: the rung a `delegate_task` with no rung runs on. With no ledger task or no earlier attempt of this role on
 * it: the ladder's default. Else that attempt's rung, one step up the ladder when it, or an attempt on the same ledger
 * task that ended after it (a review), ended for a rung reason; at the top it stays there. A rung the ladder no longer
 * holds falls back to the default.
 */
export function ladderRung(
  a: ArchState,
  role: Role,
  ledgerTask: string | null,
  ladder: readonly string[],
  dflt: string,
): string {
  if (ledgerTask === null) return dflt;
  const tries = attemptsOn(a, ledgerTask).filter((t) => t.state === "ended" && t.endedSeq !== null);
  const last = lastEnded(tries.filter((t) => t.role === role));
  const at = last ? ladder.indexOf(last.rung) : -1;
  if (!last || at < 0) return dflt;
  const climb = tries.some((t) => t.climbs && (t.endedSeq as number) >= (last.endedSeq as number));
  return (climb ? ladder[at + 1] : undefined) ?? last.rung;
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

/** The architect's own calls, and the owner's through `catherd call`: their results wake the architect. */
const byArchitect = (by: string): boolean =>
  by === "owner" || by === "architect" || by.startsWith("architect-");

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
 * Folds `e` into the architect's part of the state; false leaves the event to the rest of the reducer (the run's
 * start, pause, cancel, questions parked and reminded, reports, ticks, the run's end).
 */
export function applyArchitect(s: RunState, e: RunEvent): boolean {
  const a = s.arch;
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
        // an adopted turn (the daemon died before its event) has no upTo: deliver twice rather than lose an item
        const upTo = e.upTo ?? 0;
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
      // a machine pause is a wait, not a refusal: the task or the turn starts once `pause.lifted` clears it
      if (e.code === "E_ADMIT_PAUSED") {
        s.held ??= e.at;
        return true;
      }
      if (t) {
        t.state = "refused";
        push(
          a,
          e,
          `${t.taskId} (${t.role}) could not start: ${e.code} ${e.message}`,
          byArchitect(t.by),
          t.taskId,
        );
      } else if (e.unit === RUN_UNIT && e.code !== "E_RUNG_HELD") {
        // a held quota is the wake's wait, not the architect's failure
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
      t.endedSeq = e.seq;
      t.climbs =
        e.status === "failed" ||
        e.status === "timeout" ||
        e.reason === "too_hard" ||
        (REVIEW_ROLES.includes(t.role) && e.findings.some((f) => f.label === "BLOCKER"));
      const mine = byArchitect(t.by);
      const notes = [
        ...(e.reason ? [e.reason] : []),
        ...(t.ledgerTask
          ? [`attempt ${attemptsOn(a, t.ledgerTask).length} of ${s.caps.attempts} on ${t.ledgerTask}`]
          : []),
      ];
      const ended = `ended ${t.outcome}${notes.length ? ` (${notes.join(", ")})` : ""}`;
      push(
        a,
        e,
        mine
          ? `${t.taskId} (${t.role}${t.ledgerTask ? `, ledger ${t.ledgerTask}` : ""}) ${ended}: ${e.why || "no reason given"}; reply ${e.replyPath}`
          : `${t.taskId} (${t.role}, for ${t.by}) ${ended}; reply ${e.replyPath}`,
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
        endedSeq: null,
        climbs: false,
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
      a.newsSeq = e.seq;
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
      // writing progress names no task and is not news: the architect does it every turn
      for (const id of e.tasks) a.ledgerNews[id] = e.seq;
      return true;
    case "thread.sent":
      return true;
    case "run.finishing":
      a.idle = 0;
      a.finishing ??= { verdict: e.verdict, why: e.why };
      return true;
    case "question.parked":
      a.idle = 0;
      return false;
    case "question.answered":
      a.newsSeq = e.seq;
      delete s.questions[e.unit];
      recomputeWake(s);
      push(a, e, `the owner answered (${e.unit}): ${e.answer}`);
      return true;
    case "effect.failed": {
      if (e.action === "report" || e.action === "notify" || e.action === "remind") return true;
      if (e.action === "finish" || e.action === "cancel") {
        const key = `${e.action}@${e.unit}`;
        s.failedEffects[key] = (s.failedEffects[key] ?? 0) + 1;
      }
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

import { CAP_GRACE_MS, CAP_WARN } from "./caps.ts";
import { quotaOf } from "./failover.ts";
import { modelFamily, tryParseRung } from "./ids.ts";
import type { TaskAttempt } from "./ledger.ts";
import type { Role } from "./roles.ts";
import { type Finding, type Handling, RUN_UNIT, type RunEvent } from "./run-events.ts";
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
  /** spec D7: it ended for a reason a stronger rung may fix (failed, timeout, too_hard) */
  climbs: boolean;
  /** spec D7: a review that found an IMPORTANT (or a BLOCKER), which climbs the worker's ladder, never its own */
  blocks: boolean;
  /** the seq of its `task.delegated` */
  delegatedSeq: number;
  /** plan 51, spec D8: a review's findings, numbered from 1 in this order, and how the architect handled each */
  findings: Finding[];
  handled: Record<number, Handling>;
  /** a review's snapshot of the tree it read, the next review's base; a review on its author's family */
  snapshot: string | null;
  sameFamily: boolean;
  /** plan 53, spec D6: the fast check catherd runs on the run's tree when the task ends complete */
  check: string | null;
}

export interface ArchCheck {
  checkId: string;
  command: string;
  scope: "fast" | "full";
  base: boolean;
  fresh: boolean;
  state: "queued" | "done";
  /** plan 53, spec D6: the task whose end catherd ran this fast check for; absent when the architect asked */
  task?: string;
}

/** Plan 50, spec D11: a land the architect asked for. */
export interface ArchLand {
  landId: string;
  final: boolean;
  why: string;
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
  lands: Record<string, ArchLand>;
  /** a final land asked the owner to merge: the owner's answer ends the run done (spec D11) */
  mergeAsked: boolean;
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
    lands: {},
    mergeAsked: false,
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
    a.finishing = {
      verdict: "stopped",
      why: `cap: the run's wall time (${hours(cap)}) is spent`,
    };
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

/** The role whose IMPORTANT finding climbs the ledger task's ladder (spec D7, D8). */
const REVIEW_ROLES: readonly Role[] = ["reviewer"];
/** Roles whose dispatch on a ledger task is not an attempt at it: they read or check the work (spec D10's cap). */
const READERS: readonly Role[] = ["reviewer", "verifier", "researcher"];
/** Spec D8: review rounds on one ledger task before the architect must replan it. */
export const REVIEW_ROUNDS = 3;

/** Spec D10's attempts cap counts the dispatches that worked the ledger task, never its reviews or checks. */
export const workAttempts = (a: ArchState, ledgerTask: string): ArchTask[] =>
  attemptsOn(a, ledgerTask).filter((t) => !READERS.includes(t.role));

/** A review that ended without a usable reply (failed, timed out, blocked or refused): no round, no diff base. */
const failedReview = (t: ArchTask): boolean =>
  t.outcome !== null &&
  (!t.outcome.startsWith("ok/") || t.outcome === "ok/blocked" || t.outcome === "ok/refused");

/**
 * Spec D8: the reviews of a ledger task since the architect last edited it: a replan starts the count again. A review
 * that ended without a usable reply is no round.
 */
export const reviewRounds = (a: ArchState, ledgerTask: string): ArchTask[] =>
  attemptsOn(a, ledgerTask).filter(
    (t) => t.role === "reviewer" && !failedReview(t) && t.delegatedSeq > (a.ledgerNews[ledgerTask] ?? 0),
  );

/** The ledger task's last usable review that ended with a snapshot: a re-review reads only the diff since it (spec D8). */
export const lastReview = (a: ArchState, ledgerTask: string): ArchTask | undefined =>
  lastEnded(
    attemptsOn(a, ledgerTask).filter((t) => t.role === "reviewer" && t.snapshot !== null && !failedReview(t)),
  );

/**
 * The rung whose work a review reads: the ledger task's latest work attempt that started (running or ended; a queued,
 * cancelled or refused one has done no work), else the run's latest such attempt; null when nothing was worked yet.
 */
export function authorRung(a: ArchState, ledgerTask: string | null): string | null {
  const work = Object.values(a.tasks).filter(
    (t) =>
      !READERS.includes(t.role) && t.dispatchId !== null && t.state !== "cancelled" && t.state !== "refused",
  );
  const mine = ledgerTask === null ? [] : work.filter((t) => t.ledgerTask === ledgerTask);
  const pick = (ts: ArchTask[]) =>
    ts.reduce<ArchTask | undefined>((x, t) => (!x || t.delegatedSeq > x.delegatedSeq ? t : x), undefined);
  return (pick(mine) ?? pick(work))?.rung ?? null;
}

/**
 * Spec D8: a review with no rung runs on the first rung of another model family than the author's, from `from` (the
 * ladder's pick) upward, then from the bottom; with none on the ladder it runs on `from`, marked same-family.
 */
export function crossFamilyRung(
  ladder: readonly string[],
  from: string,
  author: string | null,
): { rung: string; sameFamily: boolean } {
  const family = author === null ? null : modelFamily(author);
  if (family === null) return { rung: from, sameFamily: false };
  const at = Math.max(0, ladder.indexOf(from));
  const other = [...ladder.slice(at), ...ladder.slice(0, at)].find((r) => modelFamily(r) !== family);
  return other === undefined ? { rung: from, sameFamily: true } : { rung: other, sameFamily: false };
}

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
  const climb = tries.some(
    (t) =>
      (t.endedSeq as number) >= (last.endedSeq as number) &&
      (t === last ? t.climbs : t.blocks && !REVIEW_ROLES.includes(role)),
  );
  return (climb ? ladder[at + 1] : undefined) ?? last.rung;
}

/**
 * Plan 52: `from` when its quota is not held, else the next rung up the ladder, then from the bottom, on a quota that
 * is not; null when every rung's quota is held.
 */
export function unheldRung(ladder: readonly string[], from: string, s: RunState): string | null {
  const at = Math.max(0, ladder.indexOf(from));
  return [...ladder.slice(at), ...ladder.slice(0, at)].find((r) => !rungHeld(r, s)) ?? null;
}

/** Plan 52: whether `rung`'s quota is held at the run's clock; a rung that does not parse is free. */
export function rungHeld(rung: string, s: RunState): boolean {
  const p = tryParseRung(rung);
  return p !== null && (s.holds[quotaOf(p)] ?? "") > s.at;
}

/**
 * Spec D8, D11: the merge request's Known issues. Ledger tasks set impossible or blocked; every review's PRE-EXISTING
 * finding and each one the architect logged as a known issue; an IMPORTANT one it logged no handling for.
 */
export function knownIssues(
  a: ArchState,
  ledger: readonly { id: string; state: string; goal: string }[],
): string[] {
  const out = ledger
    .filter((t) => t.state === "impossible" || t.state === "blocked")
    .map((t) => `${t.id} ${t.state}: ${t.goal}`);
  for (const t of Object.values(a.tasks))
    t.findings.forEach((f, i) => {
      const how = t.handled[i + 1];
      if (f.label === "PRE-EXISTING" || how === "known-issue") out.push(`${t.taskId} #${i + 1}: ${f.text}`);
      else if (f.label === "IMPORTANT" && how === undefined)
        out.push(`${t.taskId} #${i + 1} (no handling logged): ${f.text}`);
    });
  return out;
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

/** The id of the run's next check. */
export const nextCheckId = (a: ArchState): string => `C${Object.keys(a.checks).length + 1}`;

/**
 * Plan 53, spec D6: the fast check catherd runs for a task that just ended complete, from the state before its
 * `dispatch.ended`: its id and command, or null when the task has none, ended short of complete, or the run is
 * stopping.
 */
export function fastCheckFor(
  s: RunState,
  end: { name: string; status: string; replyStatus: string | null },
): { checkId: string; command: string } | null {
  const t = s.arch.tasks[end.name];
  if (!t?.check || t.state !== "working" || end.status !== "ok" || end.replyStatus !== "complete")
    return null;
  if (s.phase === "ended" || s.cancelling || s.arch.finishing) return null;
  return { checkId: nextCheckId(s.arch), command: t.check };
}

/** The architect's own calls, and the owner's through `catherd call`: their results wake the architect. */
const byArchitect = (by: string): boolean =>
  by === "owner" || by === "architect" || by.startsWith("architect-");

/** A review's findings in one digest note: `2 important, 1 nit`, or `clean`. */
function findingCounts(fs: Finding[]): string {
  const n = new Map<string, number>();
  for (const f of fs) n.set(f.label.toLowerCase(), (n.get(f.label.toLowerCase()) ?? 0) + 1);
  return n.size ? [...n].map(([l, c]) => `${c} ${l}`).join(", ") : "clean";
}

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
    !Object.values(a.lands).some((l) => l.state === "queued") &&
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
      dv.ended = {
        at: e.at,
        status: e.status,
        replyStatus: e.replyStatus,
        reason: e.reason,
      };
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
          a.finishing = {
            verdict: "stopped",
            why: "idle: two turns in a row ended with nothing running",
          };
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
      t.climbs = !e.lost && (e.status === "failed" || e.status === "timeout" || e.reason === "too_hard");
      t.blocks =
        REVIEW_ROLES.includes(t.role) &&
        e.findings.some((f) => f.label === "IMPORTANT" || f.label === "BLOCKER");
      if (t.role === "reviewer") t.findings = e.findings;
      const mine = byArchitect(t.by);
      const notes = [
        ...(e.reason ? [e.reason] : []),
        ...(t.ledgerTask && !READERS.includes(t.role)
          ? [`attempt ${workAttempts(a, t.ledgerTask).length} of ${s.caps.attempts} on ${t.ledgerTask}`]
          : []),
        ...(t.role === "reviewer" && e.status === "ok"
          ? [findingCounts(t.findings), ...(t.sameFamily ? ["same-family"] : [])]
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
        blocks: false,
        delegatedSeq: e.seq,
        findings: [],
        handled: {},
        snapshot: e.snapshot ?? null,
        sameFamily: e.sameFamily === true,
        check: e.check ?? null,
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
        ...(e.task ? { task: e.task } : {}),
      };
      a.idle = 0;
      return true;
    case "check.done": {
      a.newsSeq = e.seq;
      const c = a.checks[e.checkId];
      if (c) c.state = "done";
      const failed = `failed (exit ${e.exit ?? "timeout"}): ${e.failures.length} failing line(s)`;
      // plan 52: a full check's failures split against the base, which catherd ran itself
      const verdict = c?.scope === "fast" ? undefined : e.verdict;
      const result =
        e.exit === 0
          ? "passed"
          : verdict === "inherited"
            ? `${failed}, every one inherited from the base: it counts as passing for the verifier and land final, and they go under Known issues`
            : verdict === "new"
              ? `${failed}, ${e.failures.length - e.preExisting.length} new and ${e.preExisting.length} inherited from the base`
              : verdict === "unknown"
                ? `${failed}, not comparable with the base (no failing line read, a timeout, or no base result): you judge it`
                : `${failed}, ${e.preExisting.length} also on the base`;
      push(
        a,
        e,
        `${e.checkId} (${c?.scope ?? "check"}${c?.task ? ` check of ${c.task}` : ""}${c?.base ? ", on the base" : ""}) ${result}${e.cached ? ", from a pass on the same tree" : ""}; log ${e.logPath}`,
      );
      return true;
    }
    case "land.requested":
      a.lands[e.landId] = {
        landId: e.landId,
        final: e.final,
        why: e.why,
        state: "queued",
      };
      a.idle = 0;
      return true;
    case "land.done": {
      const l = a.lands[e.landId];
      if (l) l.state = "done";
      if (e.final && e.outcome === "pushed") a.mergeAsked = true;
      push(a, e, `${e.landId} (land${e.final ? ", final" : ""}) ${e.outcome}: ${e.message}`);
      return true;
    }
    case "ledger.changed":
      // writing progress names no task and is not news: the architect does it every turn
      for (const id of e.tasks) a.ledgerNews[id] = e.seq;
      return true;
    case "thread.sent":
    case "review.missed":
      return true;
    case "findings.handled": {
      const t = a.tasks[e.taskId];
      if (t) for (const h of e.handled) t.handled[h.n] = h.as;
      return true;
    }
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
      // spec D11: the merge question is the run's last; the run does not wait on the merge itself
      if (e.unit === RUN_UNIT && a.mergeAsked)
        a.finishing ??= {
          verdict: "done",
          why: `the owner answered the merge question: ${e.answer}`,
        };
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
      if (e.action === "land") {
        const l = a.lands[e.unit];
        if (l) l.state = "done";
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

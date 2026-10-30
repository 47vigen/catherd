import { applyArchitect, type ArchState, checkWall, emptyArch, nextWallMark } from "./architect-state.ts";
import { type Caps, DEFAULT_CAPS, type TreeMode } from "./caps.ts";
import type { BlockedReason } from "./blocked.ts";
import type { ReplyStatus, RunStatus } from "./record.ts";
import { ROLES, type Role } from "./roles.ts";
import type { NotifyMoment } from "./profile.ts";
import { EVENTS_SCHEMA, type ParkReason, type ReportKind, type RunEvent } from "./run-events.ts";

/** A quota that hit a limit holds this long, or less once a role on it finishes cleanly (spec 2.0 decision 6). */
export const HOLD_MS = 30 * 60_000;
/** An effect that fails this many times in a row is given up (a report, a cancel, the run's finish). */
export const MAX_TRIES = 2;
export const REMIND_AFTER_MS: readonly number[] = [1_800_000, 7_200_000, 21_600_000, 86_400_000];

export interface DispatchView {
  dispatchId: string;
  name: string;
  role: Role;
  unit: string;
  lane: string | null;
  rung: string;
  thread: string | null;
  startedAt: string;
  teamSeen?: number;
  ended: {
    at: string;
    status: RunStatus;
    replyStatus: ReplyStatus | null;
    reason: BlockedReason | null;
  } | null;
}

export interface OpenQuestion {
  unit: string;
  question: string;
  reason: ParkReason;
  at: string;
  reminded: number;
  remindedAt?: string;
}

/** The next scheduled slot, skipping slots missed before the last reminder was sent. */
export function remindDue(q: OpenQuestion): string {
  const day = 86_400_000;
  const n = q.reminded ?? 0;
  const nominal = REMIND_AFTER_MS[n] ?? day * (n - REMIND_AFTER_MS.length + 2);
  const elapsed = q.remindedAt ? Date.parse(q.remindedAt) - Date.parse(q.at) : -1;
  const nextSlot = REMIND_AFTER_MS.find((ms) => ms > elapsed) ?? (Math.floor(elapsed / day) + 1) * day;
  return new Date(Date.parse(q.at) + Math.max(nominal, nextSlot)).toISOString();
}

/** A report and phone notice the owner is owed: set by the event, cleared by its `report.posted`. */
export interface OwedReport {
  kind: ReportKind;
  unit: string;
  text: string;
  /** the phone notice it also sends; null for a session report only */
  moment: NotifyMoment | null;
}

/**
 * Spec D4: the state the reducer folds from a run's events. The architect's part (`arch`) is what the daemon needs
 * to run what it asked for and to wake it; the rest is the run's own: its goal, questions, pause and holds.
 */
export interface RunState {
  v: 1;
  run: string;
  seq: number;
  at: string;
  phase: "planning" | "running" | "ended";
  outcome: "done" | "cancelled" | "failed" | null;
  title: string;
  base: string | null;
  aLines: string[];
  plan: string[];
  /** the roles the profile turns off */
  rolesOff: Role[];
  /** spec D16: an earlier build started the run; this build reads it and never drives it */
  earlier: boolean;
  /** spec D10: the caps the run started with */
  caps: Caps;
  /** plan 52: the architect's ladder, its default first; empty on a run an earlier build started */
  architectRungs: string[];
  /** plan 55, spec D5: where the run's writers work, pinned at its start */
  trees: TreeMode;
  startedAt: string | null;
  /** the run's time spent in closed pauses, which the wall cap does not count */
  pausedMs: number;
  arch: ArchState;
  dispatches: Record<string, DispatchView>;
  questions: Record<string, OpenQuestion>;
  /** quota → until */
  holds: Record<string, string>;
  failedEffects: Record<string, number>;
  cancelling: boolean;
  /** when the owner paused the run (the pause in force), else null: no task and no turn starts meanwhile */
  paused: string | null;
  /** when a dispatch was refused for a machine pause; nothing starts until `pause.lifted` */
  held: string | null;
  wakeAt: string | null;
  /** `kind:unit` → a report not posted yet, so a daemon that died before it sends it again */
  owed: Record<string, OwedReport>;
}

export function emptyState(run: string): RunState {
  return {
    v: 1,
    run,
    seq: 0,
    at: "1970-01-01T00:00:00.000Z",
    phase: "planning",
    outcome: null,
    title: "",
    base: null,
    aLines: [],
    plan: [],
    rolesOff: [],
    earlier: false,
    caps: DEFAULT_CAPS,
    architectRungs: [],
    trees: "shared",
    startedAt: null,
    pausedMs: 0,
    arch: emptyArch(),
    dispatches: {},
    questions: {},
    holds: {},
    failedEffects: {},
    cancelling: false,
    paused: null,
    held: null,
    wakeAt: null,
    owed: {},
  };
}

export const liveDispatches = (s: RunState): DispatchView[] =>
  Object.values(s.dispatches).filter((d) => d.ended === null);

/** The earliest time the run must be looked at again without an event: a hold, a reminder or a cap (D10). */
export function recomputeWake(s: RunState): void {
  // Due reminders are owed actions; their pending effects must not keep the timer expired.
  const reminders =
    s.phase === "ended"
      ? []
      : Object.values(s.questions)
          .map(remindDue)
          .filter((at) => at > s.at);
  const wall = nextWallMark(s);
  const all = [...Object.values(s.holds), ...reminders, ...(wall ? [wall] : [])].sort();
  s.wakeAt = all[0] ?? null;
}

function apply(s: RunState, e: RunEvent): void {
  s.seq = e.seq;
  s.at = e.at;
  if (!applyArchitect(s, e)) applyRun(s, e);
  if (checkWall(s, e)) recomputeWake(s);
}

/** The run's own part: its start, questions, pause, cancel, ticks, reports and end. */
function applyRun(s: RunState, e: RunEvent): void {
  switch (e.type) {
    case "run.started":
      s.title = e.title;
      s.base = e.base;
      s.aLines = e.aLines;
      s.plan = e.plan;
      s.rolesOff = (e.rolesOff ?? []).filter((r): r is Role => ROLES.includes(r as Role));
      s.earlier = e.v < EVENTS_SCHEMA;
      s.caps = e.caps ?? DEFAULT_CAPS;
      s.architectRungs = e.architectRungs ?? [];
      s.trees = e.trees ?? "shared";
      s.startedAt = e.at;
      s.phase = "running";
      s.arch.inbox.push({ seq: e.seq, text: `the run started: ${e.title}`, wakes: true });
      recomputeWake(s);
      return;
    case "question.parked":
      s.questions[e.unit] = { unit: e.unit, question: e.question, reason: e.reason, at: e.at, reminded: 0 };
      recomputeWake(s);
      s.owed[`parked:${e.unit}`] = {
        kind: "parked",
        unit: e.unit,
        text: `${e.unit} is parked (${e.reason}): ${e.question}`,
        moment: "blocked",
      };
      return;
    case "question.reminded": {
      const q = s.questions[e.unit];
      if (q && e.n > q.reminded) {
        q.reminded = e.n;
        q.remindedAt = e.at;
      }
      delete s.failedEffects[`remind@${e.unit}`];
      recomputeWake(s);
      return;
    }
    case "cancel.requested":
      s.cancelling = true;
      return;
    case "run.paused":
      s.paused ??= e.at;
      recomputeWake(s);
      return;
    case "run.resumed":
      if (s.paused !== null) s.pausedMs += Date.parse(e.at) - Date.parse(s.paused);
      s.paused = null;
      recomputeWake(s);
      return;
    case "pause.lifted":
      s.held = null;
      recomputeWake(s);
      return;
    case "tick":
      for (const [k, until] of Object.entries(s.holds)) if (until <= e.at) delete s.holds[k];
      recomputeWake(s);
      return;
    case "run.ended":
      s.phase = "ended";
      s.outcome = e.outcome;
      recomputeWake(s);
      return;
    case "report.posted": {
      const key = `${e.kind}:${e.unit}`;
      if (s.owed[key]?.text === e.text) delete s.owed[key];
      return;
    }
    default:
      return;
  }
}

/** A pure fold step: `state` untouched, the next one returned. */
export function reduce(state: RunState, e: RunEvent): RunState {
  const s = structuredClone(state);
  apply(s, e);
  return s;
}

export function replay(events: RunEvent[], run = ""): RunState {
  const s = emptyState(run);
  for (const e of events) apply(s, e);
  return s;
}

import { z } from "zod";
import { BLOCKED_REASONS } from "./blocked.ts";
import { REPLY_STATUSES, RUN_STATUSES } from "./record.ts";
import { ROLES } from "./roles.ts";

/**
 * Every event carries `v`; a newer catherd's events are refused (E_RUNTIME_TOO_OLD). Plan 48 (spec D4, D16): 2 is the
 * reducer's vocabulary. A run started at 1 was written by an earlier build: this build reads it and never drives it.
 */
export const EVENTS_SCHEMA = 2;

/** The unit a run-level question or failure belongs to; a milestone is `M1`, a lane `M1.L2`. */
export const RUN_UNIT = "run";

// spelled out, not spread from BLOCKED_REASONS: a worker's `impossible` goes to the architect, never to the owner
export const PARK_REASONS = [
  "needs_user",
  "too_hard",
  "provider_error",
  "no_access",
  "check_broken",
  "out_of_scope",
  "environment",
  "preflight",
  "confirm",
  "approval",
  "blocker",
  "verifier",
  "commit",
  "land",
  "budget",
  "judge",
  "effect",
  "push",
  "decision",
  /** plan 47: the architect's ask_owner, within spec O6's stop classes */
  "owner",
] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export const REPORT_KINDS = [
  "started",
  "parked",
  "landed",
  "finished",
  "cancelled",
  "failed",
  "memory",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** The machine's action types, so `effect.failed` can name one without the events importing the machine. */
export const ACTION_TYPES = [
  "dispatch",
  "watch",
  "cancel",
  "report",
  "notify",
  "remind",
  "finish",
  /** plan 47: a check the architect asked for */
  "runCheck",
  /** plan 50: a land the architect asked for (spec D11) */
  "land",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Spec D8: what the architect did with a review finding; `known-issue` puts it under the MR's Known issues. */
export const HANDLINGS = ["fix", "rejected", "intentional", "not-worth-it", "known-issue"] as const;
export type Handling = (typeof HANDLINGS)[number];

/**
 * Spec D8: a reviewer reports `IMPORTANT`, `NIT` or `PRE-EXISTING`, each naming its bug class; a verifier's failing
 * lines are BLOCKERs; BUG is an earlier build's reviewer severity, still read.
 */
export const FindingSchema = z.object({
  label: z.enum(["IMPORTANT", "NIT", "PRE-EXISTING", "BLOCKER", "BUG"]),
  text: z.string(),
  file: z.string().nullable(),
  /** the bug class a reviewer named, so one fix covers every instance */
  class: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** A finding as it is quoted in the known issues: its text, with the label put back when the text lost it. */
export function issueLine(f: Finding): string {
  return new RegExp(`^[\\s\\-*_\\d.)]*${f.label}\\b`, "i").test(f.text) ? f.text : `${f.label} ${f.text}`;
}

const base = {
  v: z.number().int().min(1).max(EVENTS_SCHEMA),
  seq: z.number().int().min(1),
  at: z.string(),
};
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...base, type: z.literal(type), ...shape });

const strings = z.array(z.string());
const role = z.enum(ROLES);
const reason = z.enum(PARK_REASONS);
const outcome = z.enum(["done", "cancelled", "failed"]);

/** One fact about a run. Only effects and clients append events; the machine never does. */
export const RunEventSchema = z.discriminatedUnion("type", [
  ev("run.started", {
    repo: z.string(),
    title: z.string(),
    aLines: strings,
    plan: strings,
    base: z.string().nullable(),
    /** plan 47's switch, on a run an earlier build started: "2.0" was its pipeline (plan 48 deletes it) */
    engine: z.enum(["2.0", "architect"]).optional(),
    /** the roles the run's profile turns off, so the machine never waits on one (absent before 2.0.x); a role since deleted (the judge) is read and filtered where consumed */
    rolesOff: strings.optional(),
    /** plan 48, spec D10: the profile's caps when the run started; absent means DEFAULT_CAPS */
    caps: z.object({ wallMin: z.number().positive(), attempts: z.number().int().positive() }).optional(),
  }),
  ev("daemon.started", { pid: z.number().int(), version: z.string() }),
  ev("dispatch.started", {
    dispatchId: z.string(),
    name: z.string(),
    role,
    unit: z.string(),
    lane: z.string().nullable(),
    rung: z.string(),
    thread: z.string().nullable(),
    /** the last team message number when its brief was rendered; older lines have none (their startedAt is used) */
    teamSeen: z.number().int().min(0).optional(),
    /** plan 47: an architect turn's digest covers the events up to this seq */
    upTo: z.number().int().min(0).optional(),
  }),
  ev("dispatch.refused", {
    name: z.string(),
    unit: z.string(),
    code: z.string(),
    message: z.string(),
    /** plan 44 D18: the decided rung an admission refusal (E_ADMIT_RUNG) named; older lines have none */
    rung: z.string().optional(),
  }),
  ev("dispatch.ended", {
    dispatchId: z.string(),
    name: z.string(),
    unit: z.string(),
    status: z.enum(RUN_STATUSES),
    replyStatus: z.enum(REPLY_STATUSES).nullable(),
    reason: z.enum(BLOCKED_REASONS).nullable(),
    why: z.string(),
    thread: z.string().nullable(),
    head: z.string().nullable(),
    environment: z.string().nullable(),
    verdict: z.enum(["pass", "fail", "blocked"]).nullable(),
    findings: z.array(FindingSchema),
    replyPath: z.string(),
    /** a verifier's ok reply whose first line is no verdict: its `fail` is catherd's reading, not the verifier's */
    noVerdict: z.literal(true).optional(),
    /** plan 49: catherd lost the dispatch (a daemon restart, no adapter), so no rung is to blame and none climbs */
    lost: z.literal(true).optional(),
  }),
  /** `why`: the architect's reason for an ask_owner (plan 47); other parks have none */
  ev("question.parked", { unit: z.string(), question: z.string(), reason, why: z.string().optional() }),
  ev("question.reminded", { unit: z.string(), n: z.number().int().min(1) }),
  ev("question.answered", { unit: z.string(), answer: z.string(), by: z.enum(["owner", "judge"]) }),
  /** plan 40: a daemon step waited for a lock (a heavy slot or a role's): one event per wait */
  ev("lock.waiting", {
    unit: z.string(),
    lock: z.string(),
    holder: z.string().nullable(),
    ahead: z.number().int(),
  }),
  ev("cancel.requested", { by: z.literal("owner") }),
  /** plan 37: the owner holds one run; live roles finish, nothing new starts until `run.resumed` */
  ev("run.paused", { by: z.literal("owner") }),
  ev("run.resumed", { by: z.literal("owner") }),
  /** plan 43: no machine pause covers the run any more: what a refused dispatch held is owed again */
  ev("pause.lifted", {}),
  ev("effect.failed", {
    action: z.enum(ACTION_TYPES),
    unit: z.string(),
    message: z.string(),
  }),
  ev("report.posted", { kind: z.enum(REPORT_KINDS), unit: z.string(), text: z.string() }),
  ev("tick", {}),
  /** plan 47, the architect engine: what its tools asked for, each with the caller's one-line `why` (spec D3) */
  ev("task.delegated", {
    taskId: z.string(),
    role,
    rung: z.string(),
    thread: z.string().nullable(),
    ledgerTask: z.string().nullable(),
    by: z.string(),
    why: z.string(),
    /** plan 51, spec D8: a review on a rung of the author's own model family */
    sameFamily: z.literal(true).optional(),
    /** plan 51: a review's snapshot of the tree it reviews (a commit no ref holds), the next review's base */
    snapshot: z.string().optional(),
  }),
  /** plan 51, spec D8: how the architect handled a review's findings, numbered as task_status lists them */
  ev("findings.handled", {
    taskId: z.string(),
    handled: z.array(z.object({ n: z.number().int().min(1), as: z.enum(HANDLINGS) })),
    by: z.string(),
    why: z.string(),
  }),
  /** plan 51, spec D8: a bug a review missed and something later caught: the reviewer eval set */
  ev("review.missed", {
    ledgerTask: z.string(),
    review: z.string().nullable(),
    bug: z.string(),
    caughtBy: z.enum(["check", "verifier", "owner", "review"]),
    by: z.string(),
    why: z.string(),
  }),
  ev("task.cancelled", { taskId: z.string(), by: z.string(), why: z.string() }),
  /** the architect read a finished task with task_status: its digest line is delivered */
  ev("task.read", { taskId: z.string() }),
  ev("check.requested", {
    checkId: z.string(),
    command: z.string(),
    scope: z.enum(["fast", "full"]),
    base: z.boolean(),
    fresh: z.boolean(),
    by: z.string(),
    why: z.string(),
  }),
  ev("check.done", {
    checkId: z.string(),
    exit: z.number().int().nullable(),
    failures: strings,
    /** failing lines the base's own check of the same command also had */
    preExisting: strings,
    /** a pass recorded on the same tree, reused instead of run again */
    cached: z.boolean(),
    minutes: z.number(),
    logPath: z.string(),
  }),
  /** plan 50, spec D11: the architect's land, and what it did: pushed (and asked when final) or refused */
  ev("land.requested", { landId: z.string(), final: z.boolean(), by: z.string(), why: z.string() }),
  /** the intent, appended before the push: a daemon that dies after the push still knows the branch is its own */
  ev("land.started", { landId: z.string(), branch: z.string(), sha: z.string() }),
  ev("land.done", {
    landId: z.string(),
    final: z.boolean(),
    outcome: z.enum(["pushed", "refused"]),
    branch: z.string(),
    sha: z.string().nullable(),
    mr: z.string().nullable(),
    message: z.string(),
  }),
  ev("ledger.changed", { tasks: strings, progress: z.boolean(), by: z.string(), why: z.string() }),
  ev("thread.sent", {
    to: z.string(),
    n: z.number().int(),
    delivery: z.enum(["steered", "queued", "resumed"]),
    by: z.string(),
    why: z.string(),
  }),
  ev("run.finishing", {
    verdict: z.enum(["done", "impossible", "stopped"]),
    by: z.string(),
    why: z.string(),
  }),
  ev("run.ended", { outcome, reportPath: z.string().nullable() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];
/** An event as an effect or client writes it: the store adds `v`, `seq` and `at`. */
export type RunEventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "v" | "seq" | "at">
    : never
  : never;

const one = (s: string): string => s.split("\n")[0]?.trim() ?? "";

/**
 * One line about an event, for the timeline and the report; never a reply body. `rungOf` names the rung a
 * dispatch ran on (the ended event does not carry it): the state's dispatch table gives it.
 */
export function describeEvent(e: RunEvent, rungOf?: (dispatchId: string) => string | undefined): string {
  switch (e.type) {
    case "run.started":
      return `run started: ${e.title}`;
    case "daemon.started":
      return `daemon started (pid ${e.pid}, catherd ${e.version})`;
    case "dispatch.started":
      return `${e.name} started on ${e.rung}`;
    case "dispatch.refused":
      return `${e.name} refused: ${e.code}`;
    case "dispatch.ended": {
      const rung = rungOf?.(e.dispatchId);
      return `${e.name} ended ${e.status} (${e.replyStatus ?? "no status"})${rung ? ` on ${rung}` : ""}`;
    }
    case "lock.waiting":
      return `${e.unit} waits for the ${e.lock} lock${e.holder ? `, held by ${e.holder}` : ""} (${e.ahead} ahead)`;
    case "question.parked":
      return `${e.unit} parked (${e.reason}): ${one(e.question)}`;
    case "question.reminded":
      return `${e.unit} reminder ${e.n}`;
    case "question.answered":
      return `${e.unit} answered by the ${e.by}`;
    case "cancel.requested":
      return `cancel requested by the ${e.by}`;
    case "run.paused":
      return `run paused by the ${e.by}`;
    case "run.resumed":
      return `run resumed by the ${e.by}`;
    case "pause.lifted":
      return "the machine pause was lifted";
    case "effect.failed":
      return `${e.action} on ${e.unit} failed: ${one(e.message)}`;
    case "report.posted":
      return `report (${e.kind}) on ${e.unit}`;
    case "tick":
      return "tick";
    case "task.delegated":
      return `${e.by} delegated ${e.taskId} to the ${e.role} on ${e.rung}${e.sameFamily ? " (same-family review)" : ""}: ${one(e.why)}`;
    case "findings.handled":
      return `${e.by} handled ${e.taskId}'s findings (${e.handled.map((h) => `${h.n} ${h.as}`).join(", ")}): ${one(e.why)}`;
    case "review.missed":
      return `${e.by} logged a bug the review missed on ${e.ledgerTask}, caught by the ${e.caughtBy}: ${one(e.bug)}`;
    case "task.cancelled":
      return `${e.by} cancelled ${e.taskId}: ${one(e.why)}`;
    case "task.read":
      return `${e.taskId} read`;
    case "check.requested":
      return `${e.by} asked for check ${e.checkId} (${e.scope}${e.base ? ", base" : ""}): ${one(e.why)}`;
    case "check.done":
      return `check ${e.checkId} ${e.exit === 0 ? "passed" : `failed (exit ${e.exit ?? "timeout"})`}${e.cached ? " (cached)" : ""}`;
    case "land.requested":
      return `${e.by} asked to land${e.final ? " (final)" : ""} ${e.landId}: ${one(e.why)}`;
    case "land.started":
      return `land ${e.landId} is pushing ${e.branch} at ${e.sha.slice(0, 12)}`;
    case "land.done":
      return `land ${e.landId} ${e.outcome}: ${one(e.message)}`;
    case "ledger.changed":
      return `${e.by} changed the ledger${e.tasks.length ? ` (${e.tasks.join(", ")})` : ""}: ${one(e.why)}`;
    case "thread.sent":
      return `${e.by} sent #${e.n} to ${e.to} (${e.delivery}): ${one(e.why)}`;
    case "run.finishing":
      return `${e.by} finishes the run ${e.verdict}: ${one(e.why)}`;
    case "run.ended":
      return `run ended ${e.outcome}`;
  }
}

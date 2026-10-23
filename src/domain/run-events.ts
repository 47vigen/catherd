import { z } from "zod";
import { BLOCKED_REASONS } from "./blocked.ts";
import { JUDGE_KINDS, JudgeDecisionSchema } from "./judge.ts";
import { REPLY_STATUSES, RUN_STATUSES } from "./record.ts";
import { ROLES } from "./roles.ts";

/** Every line of a run's events.jsonl carries `v`; a newer catherd's events are refused (E_RUNTIME_TOO_OLD). */
export const EVENTS_SCHEMA = 1;

/** The unit a run-level question or failure belongs to; a milestone is `M1`, a lane `M1.L2`. */
export const RUN_UNIT = "run";

export const PARK_REASONS = [
  ...BLOCKED_REASONS,
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
] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export const REPORT_KINDS = ["started", "parked", "landed", "finished", "cancelled", "failed"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** The machine's action types, so `effect.failed` can name one without the events importing the machine. */
export const ACTION_TYPES = [
  "dispatch",
  "watch",
  "readPlan",
  "route",
  "fastCheck",
  "commit",
  "climb",
  "judge",
  "classify",
  "park",
  "land",
  "checkMerged",
  "integrate",
  "claimTree",
  "pushBranch",
  "cancel",
  "report",
  "notify",
  "finish",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const FindingSchema = z.object({
  label: z.enum(["BLOCKER", "BUG", "NIT"]),
  text: z.string(),
  file: z.string().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** A finding as it is quoted in the known issues: its text, with the label put back when the text lost it. */
export function issueLine(f: Finding): string {
  return new RegExp(`^[\\s\\-*_\\d.)]*${f.label}\\b`, "i").test(f.text) ? f.text : `${f.label} ${f.text}`;
}

export const MilestonePlanSchema = z.object({
  id: z.string(),
  title: z.string(),
  after: z.array(z.string()),
  lanes: z.array(
    z.object({
      id: z.string(),
      role: z.enum(ROLES),
      kind: z.string().nullable(),
      after: z.array(z.string()),
      owns: z.array(z.string()),
    }),
  ),
});
export type MilestonePlan = z.infer<typeof MilestonePlanSchema>;

const base = {
  v: z.literal(EVENTS_SCHEMA),
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
    engine: z.literal("2.0"),
    /** the roles the run's profile turns off, so the machine never waits on one (absent before 2.0.x) */
    rolesOff: z.array(role).optional(),
  }),
  ev("daemon.started", { pid: z.number().int(), version: z.string() }),
  ev("plan.ready", { milestones: z.array(MilestonePlanSchema) }),
  ev("plan.approved", { by: z.enum(["owner", "input"]) }),
  ev("lanes.routed", {
    milestone: z.string(),
    lanes: z.array(z.object({ lane: z.string(), rung: z.string(), ladder: strings })),
  }),
  ev("preflight.done", {
    milestone: z.string(),
    blocking: z.array(z.object({ lane: z.string(), note: z.string() })),
    confirm: strings.nullable(),
    /** plan 34: the plan lint's warnings; older lines have none */
    lint: strings.default([]),
  }),
  ev("dispatch.started", {
    dispatchId: z.string(),
    name: z.string(),
    role,
    unit: z.string(),
    lane: z.string().nullable(),
    rung: z.string(),
    thread: z.string().nullable(),
    /** a judge call's kind: the machine asks the same question again from it when the reply is unreadable */
    judgeKind: z.enum(JUDGE_KINDS).nullable().optional(),
  }),
  ev("dispatch.refused", { name: z.string(), unit: z.string(), code: z.string(), message: z.string() }),
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
    foreign: strings,
    replyPath: z.string(),
  }),
  ev("check.ran", {
    lane: z.string(),
    exit: z.number().int().nullable(),
    tail: z.string(),
    foreign: strings,
  }),
  ev("commit.made", { milestone: z.string(), round: z.number().int().min(0), commit: z.string() }),
  ev("commit.failed", { milestone: z.string(), round: z.number().int().min(0), tail: z.string() }),
  ev("lane.climbed", { lane: z.string(), rung: z.string(), top: z.boolean() }),
  ev("stop.classified", { dispatchId: z.string(), reason: z.enum(BLOCKED_REASONS).nullable() }),
  ev("judge.decided", {
    id: z.string(),
    unit: z.string(),
    kind: z.enum(JUDGE_KINDS),
    decision: JudgeDecisionSchema,
    dispatchId: z.string(),
  }),
  ev("judge.failed", { id: z.string(), unit: z.string(), why: z.string() }),
  ev("question.parked", { unit: z.string(), question: z.string(), reason }),
  ev("question.answered", { unit: z.string(), answer: z.string(), by: z.enum(["owner", "judge"]) }),
  ev("milestone.landed", {
    milestone: z.string(),
    commit: z.string(),
    knownIssues: strings,
    digestPath: z.string(),
    /** the branch the run works on, named in the owner's push question; absent in a run without a base */
    branch: z.string().nullable().optional(),
  }),
  ev("land.refused", { milestone: z.string(), code: z.string(), message: z.string(), fix: z.string() }),
  ev("milestone.merged", { milestone: z.string() }),
  ev("base.behind", { milestone: z.string() }),
  ev("integrate.done", { milestone: z.string(), commit: z.string() }),
  ev("integrate.conflict", { milestone: z.string(), files: strings }),
  /** plan 35: a base run's milestone has its worktree (the tree, its branch, what the claim noted) */
  ev("tree.ready", {
    milestone: z.string(),
    tree: z.string(),
    branch: z.string(),
    base: z.string(),
    hints: strings,
  }),
  /** plan 35: no room in memory for another milestone yet; the claim is tried again later */
  ev("tree.deferred", { milestone: z.string(), availableMb: z.number(), needMb: z.number() }),
  /** plan 35: catherd pushed the milestone's branch on the owner's word; `mr` is the command that opens its MR */
  ev("branch.pushed", {
    milestone: z.string(),
    branch: z.string(),
    remote: z.literal("origin"),
    mr: z.string(),
  }),
  ev("cancel.requested", { by: z.literal("owner") }),
  /** plan 37: the owner holds one run; live roles finish, nothing new starts until `run.resumed` */
  ev("run.paused", { by: z.literal("owner") }),
  ev("run.resumed", { by: z.literal("owner") }),
  ev("effect.failed", { action: z.enum(ACTION_TYPES), unit: z.string(), message: z.string() }),
  ev("report.posted", { kind: z.enum(REPORT_KINDS), unit: z.string(), text: z.string() }),
  ev("tick", {}),
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
    case "plan.ready":
      return `plan ready: ${e.milestones.map((m) => m.id).join(", ") || "no milestones"}`;
    case "plan.approved":
      return `plan approved by the ${e.by}`;
    case "lanes.routed":
      return `${e.milestone} routed: ${e.lanes.map((l) => `${l.lane} on ${l.rung}`).join(", ") || "no lanes"}`;
    case "preflight.done": {
      const lint = e.lint.length ? ` · ${e.lint.length} lint warning(s)` : "";
      return e.blocking.length
        ? `${e.milestone} preflight blocked: ${e.blocking.map((b) => b.lane).join(", ")}${lint}`
        : e.confirm
          ? `${e.milestone} preflight waits for confirmation${lint}`
          : `${e.milestone} preflight passed${lint}`;
    }
    case "dispatch.started":
      return `${e.name} started on ${e.rung}`;
    case "dispatch.refused":
      return `${e.name} refused: ${e.code}`;
    case "dispatch.ended": {
      const rung = rungOf?.(e.dispatchId);
      return `${e.name} ended ${e.status} (${e.replyStatus ?? "no status"})${rung ? ` on ${rung}` : ""}`;
    }
    case "check.ran":
      return `${e.lane} fast check ${e.exit === 0 ? "passed" : `failed (exit ${e.exit ?? "timeout"})`}`;
    case "commit.made":
      return `${e.milestone} committed ${e.commit.slice(0, 7)} (round ${e.round})`;
    case "commit.failed":
      return `${e.milestone} commit failed (round ${e.round})`;
    case "lane.climbed":
      return `${e.lane} climbed to ${e.rung}${e.top ? " (top rung)" : ""}`;
    case "stop.classified":
      return `dispatch ${e.dispatchId} stop classified: ${e.reason ?? "none"}`;
    case "judge.decided":
      return `judge ${e.id} on ${e.unit} (${e.kind}): ${e.decision.verb}`;
    case "judge.failed":
      return `judge ${e.id} on ${e.unit} failed: ${one(e.why)}`;
    case "question.parked":
      return `${e.unit} parked (${e.reason}): ${one(e.question)}`;
    case "question.answered":
      return `${e.unit} answered by the ${e.by}`;
    case "milestone.landed":
      return `${e.milestone} landed at ${e.commit.slice(0, 7)}${e.knownIssues.length ? ` with ${e.knownIssues.length} known issue(s)` : ""}`;
    case "land.refused":
      return `${e.milestone} land refused: ${e.code}`;
    case "milestone.merged":
      return `${e.milestone} merged`;
    case "base.behind":
      return `${e.milestone} is behind its base`;
    case "integrate.done":
      return `${e.milestone} integrated at ${e.commit.slice(0, 7)}`;
    case "integrate.conflict":
      return `${e.milestone} integration conflict in ${e.files.length} file(s)`;
    case "tree.ready":
      return `${e.milestone} has its worktree on branch ${e.branch}`;
    case "tree.deferred":
      return `${e.milestone} waits for memory: ${e.availableMb} MB available, ${e.needMb} MB needed`;
    case "branch.pushed":
      return `${e.milestone}'s branch ${e.branch} is pushed to ${e.remote}`;
    case "cancel.requested":
      return `cancel requested by the ${e.by}`;
    case "run.paused":
      return `run paused by the ${e.by}`;
    case "run.resumed":
      return `run resumed by the ${e.by}`;
    case "effect.failed":
      return `${e.action} on ${e.unit} failed: ${one(e.message)}`;
    case "report.posted":
      return `report (${e.kind}) on ${e.unit}`;
    case "tick":
      return "tick";
    case "run.ended":
      return `run ended ${e.outcome}`;
  }
}

import type { BlockedReason } from "./blocked.ts";
import { quotaOf } from "./failover.ts";
import type { DecisionSource } from "./decision.ts";
import { checkFailLines } from "./fail-lines.ts";
import { findingKey, HARNESS_NOTE, failureSignature } from "./harness.ts";
import { filesOf } from "./findings.ts";
import { MEMORY_LIMITS } from "./milestone-memory.ts";
import { tryParseRung } from "./ids.ts";
import { type JudgeKind, judgeName, type RuleChange } from "./judge.ts";
import type { ReplyStatus, RunStatus } from "./record.ts";
import { ROLES, type Role } from "./roles.ts";
import type { NotifyMoment } from "./profile.ts";
import { isPushAnswer } from "./branch.ts";
import { isAccept } from "./plan-doc.ts";
import {
  type Finding,
  issueLine,
  type MilestonePlan,
  type ParkReason,
  type ReportKind,
  RUN_UNIT,
  type RunEvent,
} from "./run-events.ts";

/** A quota that hit a limit holds this long, or less once a role on it finishes cleanly (spec 2.0 decision 6). */
export const HOLD_MS = 30 * 60_000;
/** A paused machine, or a refusal that clears itself, is tried again after this long. */
export const REFUSAL_WAIT_MS = 5 * 60_000;
/** Admission refusals in a row (order or overlap) before a lane parks as an effect. */
export const ADMIT_WAITS = 12;
/** A lane parked this many times at the top rung stops asking the judge and waits for the owner. */
export const TOP_RUNG_JUDGES = 3;
/** A decision dropped (stale, held, refused at admission) this many times in a row parks its unit. */
export const REDECIDE_LIMIT = 6;
/** A name refused as a duplicate this many times in a row parks its unit. */
export const DUPLICATE_LIMIT = 3;
/** A role that fails this many times without a limit parks its unit; the same rung failing this often makes the floor strict. */
export const MAX_TRIES = 2;
/** plan 44 D16: calls to the decision model for one dispatch (or classification) before its unit parks. */
export const DECISION_TRIES = 3;
/** plan 44 D16: the wait between two calls to a decision model that gave no usable answer. */
export const DECISION_RETRY_MS = 60_000;
export const REMIND_AFTER_MS: readonly number[] = [1_800_000, 7_200_000, 21_600_000, 86_400_000];
/** A plan the check refused goes back to its architect this many times before the run parks (plan 32). */
export const PLAN_REVISIONS = 2;

/** Spec 2.0 decision 5: a soft cap of max(3, 2 + ⌈lanes/3⌉) fix rounds. */
export const softCap = (lanes: number): number => Math.max(3, 2 + Math.ceil(lanes / 3));

export { findingKey };

export type MilestoneStatus =
  | "waiting"
  | "routing"
  | "lanes"
  | "committing"
  | "review"
  | "fixing"
  | "verifying"
  | "integrating"
  | "landing"
  | "landed"
  | "merged"
  | "parked";
export type LaneStatus = "pending" | "running" | "checking" | "done" | "parked";

/** What a lane's dispatch said when it ended, for the part of the state it changes. */
interface LaneEnd {
  rung: string;
  status: RunStatus;
  replyStatus: ReplyStatus | null;
  thread: string | null;
  why: string;
  foreign: string[];
  siblings: string[];
}

export interface LaneState {
  id: string;
  milestone: string;
  role: Role;
  kind: string | null;
  after: string[];
  owns: string[];
  status: LaneStatus;
  /** the rung of the lane's latest decision or dispatch (an old run: its last climb) */
  rung: string | null;
  /** the thread its CLI session is on, resumed by a check retry and a fix round; null starts fresh */
  thread: string | null;
  /** its last climb reached the top rung */
  top: boolean;
  /** failed or partial tries since the last ok end or climb */
  checkFails: number;
  lastFails: string[] | null;
  /** the tree key the last check failure was seen on; old events use the milestone commit */
  lastFailHead: string | null;
  /** the rung whose quota hit a limit: the next dispatch takes a stand-in */
  failoverFrom: string | null;
  lastReason: BlockedReason | null;
  /** how many times the lane stood at the top rung (the judge is asked each time, up to TOP_RUNG_JUDGES) */
  sameReason: number;
  notes: string[];
  /** the review round whose fix this lane was armed for (a survived finding climbs first) */
  fixedRound: number | null;
  /** how many stops in a row named `lastReason` (a provider_error is retried once, a check_broken waits once) */
  stopRun: number;
  /** a provider_error that repeated: the next dispatch fails over although no limit was hit */
  failoverNow: boolean;
  /** the lane's last stop was too_hard: with no rung above its floor the owner is asked, not the judge */
  tooHard: boolean;
  /** what the judge is asked about the parked lane: an owner-level question, or a lane out of rungs */
  awaiting: "question" | "unexpected" | null;
  /** an unexplained stop waiting for its classification: nothing else happens to the lane until it is in */
  classify: (LaneEnd & { dispatchId: string; reason?: BlockedReason | null }) | null;
  /** when the lane's floor last rose (a failure of its rung; an old run: its last climb): a sibling "untried since" is judged against it */
  floorAt: string | null;
  /** plan 40: judge routes that arrived while the lane was running or checking: its notes when that try ends */
  queued: string[];
  /** plan 40: sibling lanes whose files broke the lane's check: its fast check reruns once they are done */
  waitOn: string[];
  /** plan 43: the lane's last ok reply had no STATUS line and was asked for one; a second one is a failed attempt */
  statusAsked: boolean;
  /** plan 43: the digest of the lane file (without its Owns line) the lane last ran against; null before the first plan.ready that gave one */
  digest: string | null;
  /** when the lane's unbroken run of transport failures began: it retries its rung until HOLD_MS has passed */
  transportSince: string | null;
  /** plan 44 D10: the signature of the harness failure the lane was last repaired for; it outlives the repair dispatch; a passing or product-failing check clears it */
  harness: string | null;
}

export interface MilestoneState {
  id: string;
  title: string;
  after: string[];
  status: MilestoneStatus;
  parkedFrom: MilestoneStatus | null;
  /** the fix round of the latest commit (0 for the lanes' own) */
  round: number;
  /** open BLOCKER and BUG lines per completed review round */
  counts: number[];
  /** the findings still to be acted on: the round so far, then the ones no lane owns until triaged */
  open: Finding[];
  keys: string[][];
  knownIssues: string[];
  /** plan 34: the NIT lines of the latest review round; a landing keeps them as known issues */
  nits: string[];
  commit: string | null;
  verifierRuns: number;
  verifierFailedOn: string | null;
  landRefusals: number;
  /** the reviewers this review round still owes (reviewer-M, ui-reviewer-M, reviewer-M-2) */
  awaiting: string[];
  /** failures per milestone-level role name since the milestone last moved on */
  tries: Record<string, number>;
  /** findings the judge sent to the architect: the plan's next reading takes them */
  delta: string[];
  /** the owner confirmed the preflight commands */
  confirmed: boolean;
  /** what the owner answered while the milestone was parked: the next briefs of its roles carry it */
  notes: string[];
  /** what the next verifier is told: a refused landing's message and fix, or the commit to verify */
  verifierNotes: string[];
  /** a base run: the files the merge of the base left in conflict (none until it did); non-empty means committing resolves it */
  integrateFiles: string[];
  /** a base run: when to look again whether origin's base holds the landed commit */
  mergeDue: string | null;
  /** the branch the landed commit is on, for the owner's push question */
  branch: string | null;
  /** plan 35, a base run: the milestone's worktree once `tree.ready` happened */
  tree: string | null;
  /** plan 35: when the worktree became ready, for the memory a young milestone is still to take */
  treeAt: string | null;
  /** plan 35: a memory deferral: no new claim before this time */
  claimAfter: string | null;
  /** plan 38: when the first memory deferral of this claim happened; null once the tree is ready */
  memoryWaitSince: string | null;
  /** plan 35: the owner answered `push` and catherd has not pushed the branch yet */
  pushing: boolean;
  /** plan 35: the digest file the owner's MR takes as its body */
  digestPath: string | null;
  /** plan 35: the MR command of the branch catherd pushed, named in the question that asks again */
  mr: string | null;
  /** plan 40: the commit the daemon's check passed on, or whose failing findings were settled; null while a failure is open or no check ran on this commit */
  checkedOn: string | null;
  /** plan 40: the commit whose check failed with findings; accepting or dismissing those findings settles them */
  checkFailedOn: string | null;
  /** the commit whose failing check the owner accepted or the judge dismissed: the land gate takes its lines as known */
  checkWaivedOn: string | null;
  /** plan 40: the commit a verifier last passed */
  verifierPassedOn: string | null;
  /** plan 40: the delivered A-lines the check does not cover; the verifier judges those */
  uncovered: string[];
  /** plan 40: the check covers every delivered A-line, so its pass lands the milestone with no verifier */
  checkOnly: boolean;
  /** plan 40: review rounds that stopped on BLOCKERs no lane owns and went to the triage judge (at most one) */
  disputes: number;
  /** plan 40: the triage judge is deciding those BLOCKERs */
  disputing: boolean;
  /** plan 43: pre-commit hook refusals turned into a fix round since the last commit (one is, a second parks) */
  hookFixes: number;
  /** plan 43: why catherd's own merge failed; the push question then asks the owner to merge it */
  mergeError: string | null;
  /** the thread of a verifier reply that had no VERDICT line, resumed once to ask for it */
  verdictAsk: string | null;
}

export interface DispatchView {
  dispatchId: string;
  name: string;
  role: Role;
  unit: string;
  lane: string | null;
  rung: string;
  thread: string | null;
  startedAt: string;
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

export interface RunState {
  v: 1;
  run: string;
  seq: number;
  at: string;
  phase: "planning" | "approval" | "running" | "ended";
  outcome: "done" | "cancelled" | "failed" | null;
  title: string;
  base: string | null;
  aLines: string[];
  plan: string[];
  /** the roles the profile turns off */
  rolesOff: Role[];
  /** what the owner answered at run level (a parked planning role): its retried briefs carry it */
  notes: string[];
  milestones: MilestoneState[];
  lanes: Record<string, LaneState>;
  dispatches: Record<string, DispatchView>;
  questions: Record<string, OpenQuestion>;
  /** quota → until */
  holds: Record<string, string>;
  judges: Record<string, { unit: string; kind: JudgeKind; tries: number }>;
  /** plan 34: the finished run's rules review: what the judge proposed, or that it gave no readable answer */
  rulesReview: { changes: RuleChange[]; failed: boolean } | null;
  failedEffects: Record<string, number>;
  cancelling: boolean;
  /** plan 43: when a dispatch was refused for a machine pause; every paused step waits until `pause.lifted` */
  held: string | null;
  /** plan 43: `land.autoMerge`, pinned at the run's start: catherd merges a landed milestone itself */
  autoMerge: boolean;
  /** when the owner paused the run (the pause in force), else null: no dispatch, judge, claim, route, land, push or integrate starts meanwhile */
  paused: string | null;
  wakeAt: string | null;
  /** an architect ended and the plan was not read since */
  planDirty: boolean;
  /** what the next architect dispatch must change in plan.md (the owner's request, a problem the plan check found); the plan's next reading clears it */
  revise: string[];
  /** dispatch name → until: refused for now (paused, every quota held) */
  waiting: Record<string, string>;
  /** unit → what the owner must be asked: the machine parks it */
  stuck: Record<string, { reason: ParkReason; question: string }>;
  /** `kind:unit` → a report not posted yet, so a daemon that died before it sends it again */
  owed: Record<string, OwedReport>;
  /** plan 44: dispatch name → its decision, until the dispatch starts (a restart in between sends it, asking nothing) */
  decisions: Record<string, MadeDecision>;
  /** dispatch name → the `n` of its latest decision: the next decision of the name is `n + 1` */
  decided: Record<string, number>;
  /** dispatch name → the rung that failed it, and how often in a row: the floor of its next decision (R1, R2) */
  floors: Record<string, { rung: string; fails: number }>;
  /** dispatch name (or `classify:<dispatchId>`) → calls to the decision model that gave no usable answer since the last decision */
  decisionFails: Record<string, number>;
  /** dispatch name → rungs refused at admission (E_ADMIT_RUNG): its next decision leaves them out */
  refusedRungs: Record<string, string[]>;
  /** dispatch name → the rung the coordinator answered a parked decision with: the next decide records it */
  picks: Record<string, string>;
  /** unit → the name whose decision parked it (reason `decision`) */
  decisionParks: Record<string, string>;
  /** name → the rungs the parked decision's last failure listed: what an answer may name */
  decisionRungs: Record<string, string[]>;
  /** unit → the name whose exhausted floor parked it (reason `effect`): its floor goes with the answer */
  exhaustedParks: Record<string, string>;
}

/** plan 44: what `decision.made` recorded for a dispatch not started yet. */
export interface MadeDecision {
  n: number;
  rung: string;
  briefFile: string;
  briefHash: string;
  source: DecisionSource;
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
    notes: [],
    milestones: [],
    lanes: {},
    dispatches: {},
    questions: {},
    holds: {},
    judges: {},
    rulesReview: null,
    failedEffects: {},
    cancelling: false,
    paused: null,
    held: null,
    autoMerge: false,
    wakeAt: null,
    planDirty: false,
    revise: [],
    waiting: {},
    stuck: {},
    owed: {},
    decisions: {},
    decided: {},
    floors: {},
    decisionFails: {},
    refusedRungs: {},
    picks: {},
    decisionParks: {},
    decisionRungs: {},
    exhaustedParks: {},
  };
}

/** The dispatch name of a lane: its role and id. */
export const laneNameOf = (l: Pick<LaneState, "role" | "id">): string => `${l.role}-${l.id}`;

/** The role a dispatch name belongs to: the longest role it starts with. */
export const roleOfName = (name: string): Role | null =>
  [...ROLES].sort((a, b) => b.length - a.length).find((r) => name === r || name.startsWith(`${r}-`)) ?? null;

/**
 * plan 44 R1, R2, D14: `name`'s dispatch failed on `rung`. The same rung twice in a row makes the floor strict (the
 * next decision goes above it); another rung restarts the count. A lane's `floorAt` notes when its floor went strict,
 * the moment a climb used to happen. `strict` makes it so at once.
 */
export function failedOn(s: RunState, name: string, rung: string | null, at: string, strict = false): void {
  if (rung === null) return;
  const f = s.floors[name];
  if (f && f.rung === rung) f.fails += 1;
  else s.floors[name] = { rung, fails: 1 };
  const now = s.floors[name] as { fails: number };
  if (strict) now.fails = Math.max(now.fails, MAX_TRIES);
  if (now.fails < MAX_TRIES) return;
  const lane = Object.values(s.lanes).find((l) => laneNameOf(l) === name);
  if (lane) lane.floorAt = at;
}

/** The floor of `name`'s next decision, and whether it excludes its own rung. */
export function floorOf(s: RunState, name: string): { floor: string | null; strict: boolean } {
  const f = s.floors[name];
  return { floor: f?.rung ?? null, strict: (f?.fails ?? 0) >= MAX_TRIES };
}

/** The name's dispatch was accepted: its floor goes. */
const accepted = (s: RunState, name: string): void => {
  delete s.floors[name];
};

/** A decision call failed (or the model's answer was unusable): wait for the next try, or park the unit at the third. */
function decisionFailed(
  s: RunState,
  o: { name: string; unit: string; at: string; error: string; rungs: string[]; lane?: LaneState },
): void {
  const fails = (s.decisionFails[o.name] ?? 0) + 1;
  s.decisionFails[o.name] = fails;
  if (fails < DECISION_TRIES) {
    s.waiting[o.name] = isoPlus(o.at, DECISION_RETRY_MS);
    recomputeWake(s);
    return;
  }
  const classify = o.name.startsWith("classify:");
  const role = roleOfName(o.name);
  const { floor } = floorOf(s, o.name);
  s.decisionParks[o.unit] = o.name;
  s.decisionRungs[o.name] = o.rungs;
  s.stuck[o.unit] = {
    reason: "decision",
    question: classify
      ? `${o.name}: the decision model gave no usable answer (${o.error}). Answer retry to ask again; any other answer lets the stop go on unclassified, as a failure of the work.`
      : `${o.name}: the decision model gave no usable answer (${o.error}). Answer with one of the ${role ?? "role"}'s rungs${floor ? ` at or above ${floor}` : ""}: ${o.rungs.join(", ") || "none is left"}, or retry.`,
  };
  if (o.lane && !o.name.startsWith("judge-")) o.lane.status = "parked";
}

/** How often a landed milestone waits between two looks at origin's base. */
export const MERGE_CHECK_MS = 10 * 60_000;

/** The lane-less worker that resolves the conflicts of merging the base into the run's branch. */
export const integrateName = (milestone: string): string => `worker-${milestone}-integrate`;

export const isDone = (m: MilestoneState): boolean => m.status === "landed" || m.status === "merged";
/** In a base run a milestone is finished when origin's base holds it; otherwise when it landed. */
export const isFinished = (s: RunState, m: MilestoneState): boolean =>
  s.base === null ? isDone(m) : m.status === "merged";
export const lanesOf = (s: RunState, milestone: string): LaneState[] =>
  Object.values(s.lanes).filter((l) => l.milestone === milestone);
export const liveDispatches = (s: RunState): DispatchView[] =>
  Object.values(s.dispatches).filter((d) => d.ended === null);
export const milestoneOf = (s: RunState, id: string): MilestoneState | undefined =>
  s.milestones.find((m) => m.id === id);

/**
 * The milestones the machine works on. A run without base: the first one not landed, merged or parked whose `after`
 * landed. A base run (plan 35): every such one whose `after` milestones are merged and that has a tree, plus the
 * first of them without one, so trees are claimed one at a time in plan order.
 */
export function activeMilestones(s: RunState): MilestoneState[] {
  const finished = (id: string) => {
    const m = milestoneOf(s, id);
    return m === undefined || isFinished(s, m);
  };
  const open = s.milestones.filter((m) => !isDone(m) && m.status !== "parked" && m.after.every(finished));
  if (s.base === null) return open.slice(0, 1);
  let claiming = false;
  return open.filter((m) => m.tree !== null || (!claiming && (claiming = true)));
}

const bare = (p: string) => p.replace(/\/+$/, "");

/**
 * The lane owning `file` by its longest `Owns:` entry, else the one lane with an entry ending in `/<file>` (a relative
 * path), or null (no file, none owns it, or two lanes could).
 */
export function ownerOfFile(file: string | null, lanes: { id: string; owns: string[] }[]): string | null {
  if (!file) return null;
  let best: { id: string; len: number } | null = null;
  for (const l of lanes)
    for (const o of l.owns) {
      const e = bare(o);
      if ((file === e || file.startsWith(`${e}/`)) && (best === null || e.length > best.len))
        best = { id: l.id, len: e.length };
    }
  if (best) return best.id;
  const tails = new Set<string>();
  for (const l of lanes) if (l.owns.some((o) => bare(o).endsWith(`/${file}`))) tails.add(l.id);
  return tails.size === 1 ? ([...tails][0] as string) : null;
}

const lastOf = (s: RunState, name: string): DispatchView | undefined =>
  Object.values(s.dispatches)
    .filter((d) => d.name === name)
    .at(-1);

/** The rung of the latest dispatch of `name` when it ended on a usage limit, else null. */
export function limitedRung(s: RunState, name: string): string | null {
  const d = lastOf(s, name);
  return d?.ended?.status === "limit" ? d.rung : null;
}

/** The owner gave the run its plan: files in `run.started` or a `plan:` A-line. */
export const hasPlanInput = (s: RunState): boolean =>
  s.plan.length > 0 || s.aLines.some((l) => /^\s*plan:\s*\S/i.test(l));

const hasJudge = (s: RunState, unit: string): boolean => Object.values(s.judges).some((j) => j.unit === unit);

const isoPlus = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

function recomputeWake(s: RunState): void {
  const merges = s.milestones.flatMap((m) => (m.status === "landed" && m.mergeDue ? [m.mergeDue] : []));
  const claims = s.milestones.flatMap((m) => (m.claimAfter ? [m.claimAfter] : []));
  // Due reminders are owed actions; their pending effects must not keep the timer expired.
  const reminders =
    s.phase === "ended"
      ? []
      : Object.values(s.questions)
          .map(remindDue)
          .filter((at) => at > s.at);
  const all = [
    ...Object.values(s.holds),
    ...Object.values(s.waiting),
    ...merges,
    ...claims,
    ...reminders,
  ].sort();
  s.wakeAt = all[0] ?? null;
}

function mergePlan(s: RunState, plan: MilestonePlan[]): void {
  // a state older than plan 44 has none of the decision fields
  s.decisions ??= {};
  s.decided ??= {};
  s.floors ??= {};
  s.decisionFails ??= {};
  s.refusedRungs ??= {};
  s.picks ??= {};
  s.decisionParks ??= {};
  s.decisionRungs ??= {};
  s.exhaustedParks ??= {};
  const next: MilestoneState[] = [];
  for (const mp of plan) {
    const old = milestoneOf(s, mp.id);
    const m: MilestoneState = old ?? {
      id: mp.id,
      title: mp.title,
      after: mp.after,
      status: "waiting",
      parkedFrom: null,
      round: 0,
      counts: [],
      open: [],
      keys: [],
      knownIssues: [],
      nits: [],
      commit: null,
      verifierRuns: 0,
      verifierFailedOn: null,
      landRefusals: 0,
      awaiting: [],
      tries: {},
      delta: [],
      confirmed: false,
      notes: [],
      verifierNotes: [],
      integrateFiles: [],
      mergeDue: null,
      branch: null,
      tree: null,
      treeAt: null,
      claimAfter: null,
      memoryWaitSince: null,
      pushing: false,
      digestPath: null,
      mr: null,
      checkedOn: null,
      checkFailedOn: null,
      checkWaivedOn: null,
      verifierPassedOn: null,
      uncovered: [],
      checkOnly: false,
      disputes: 0,
      disputing: false,
      hookFixes: 0,
      mergeError: null,
      verdictAsk: null,
    };
    m.verifierFailedOn ??= null;
    m.checkedOn ??= null;
    m.checkFailedOn ??= null;
    m.checkWaivedOn ??= null;
    m.verifierPassedOn ??= null;
    m.uncovered ??= [];
    m.checkOnly ??= false;
    m.disputes ??= 0;
    m.disputing ??= false;
    m.hookFixes ??= 0;
    m.mergeError ??= null;
    m.verdictAsk ??= null;
    m.title = mp.title;
    m.after = mp.after;
    m.delta = [];
    for (const lp of mp.lanes) {
      const l = s.lanes[lp.id];
      if (l) {
        l.lastFails ??= null;
        l.lastFailHead ??= null;
        l.queued ??= [];
        l.waitOn ??= [];
        l.floorAt ??= null;
        l.role = lp.role;
        l.kind = lp.kind;
        l.after = lp.after;
        l.owns = lp.owns;
        l.digest ??= null;
        l.harness ??= null;
        if (lp.digest !== undefined) {
          // a lane file the architect changed makes the unsent decision stale: it was made on the old brief
          if (l.digest !== null && l.digest !== lp.digest) delete s.decisions[laneNameOf(l)];
          // a lane file the architect changed re-runs a done lane; the Owns line is not in the digest
          if (l.digest !== null && l.digest !== lp.digest && l.status === "done" && !isDone(m)) {
            l.status = "pending";
            l.checkFails = 0;
            // a milestone past its lanes goes back to them, as a fix round does
            const past = (st: MilestoneStatus | null) =>
              st !== null && !["waiting", "routing", "lanes", "fixing"].includes(st);
            if (m.status === "parked") {
              if (past(m.parkedFrom)) m.parkedFrom = "fixing";
            } else if (past(m.status)) m.status = "fixing";
            l.notes.push(
              `The architect changed lanes/${l.id}.md: re-read it and make the change it asks for.`,
            );
          }
          l.digest = lp.digest;
        }
      } else
        s.lanes[lp.id] = {
          id: lp.id,
          milestone: mp.id,
          role: lp.role,
          kind: lp.kind,
          after: lp.after,
          owns: lp.owns,
          status: "pending",
          rung: null,
          thread: null,
          top: false,
          checkFails: 0,
          lastFails: null,
          lastFailHead: null,
          failoverFrom: null,
          lastReason: null,
          sameReason: 0,
          notes: [],
          fixedRound: null,
          stopRun: 0,
          failoverNow: false,
          tooHard: false,
          awaiting: null,
          classify: null,
          floorAt: null,
          queued: [],
          waitOn: [],
          statusAsked: false,
          digest: lp.digest ?? null,
          transportSince: null,
          harness: null,
        };
    }
    next.push(m);
  }
  for (const m of s.milestones) if (!next.some((n) => n.id === m.id)) next.push(m);
  s.milestones = next;
}

const reviewersOf = (s: RunState, m: MilestoneState): string[] => [
  ...(s.rolesOff.includes("reviewer") ? [] : [`reviewer-${m.id}`]),
  ...(!s.rolesOff.includes("ui-reviewer") && lanesOf(s, m.id).some((l) => l.kind === "ui")
    ? [`ui-reviewer-${m.id}`]
    : []),
];

/** What a milestone's lanes and fix round have settled: the move to a commit, once nothing is left to do. */
function settle(s: RunState, m: MilestoneState): void {
  const lanes = lanesOf(s, m.id);
  const allDone = lanes.every((l) => l.status === "done");
  if (m.status === "lanes" && allDone) m.status = "committing";
  else if (
    m.status === "fixing" &&
    allDone &&
    m.open.length === 0 &&
    m.delta.length === 0 &&
    !s.planDirty &&
    !hasJudge(s, m.id) &&
    !s.stuck[m.id] &&
    !Object.values(s.dispatches).some((d) => d.ended === null && d.name.startsWith(`architect-${m.id}-`))
  )
    m.status = "committing";
}

function laneDone(s: RunState, l: LaneState): void {
  l.waitOn = [];
  accepted(s, laneNameOf(l));
  if (l.queued.length > 0) {
    // a route arrived during this try: the lane takes it as a new try, not as done
    l.notes = l.queued;
    l.queued = [];
    l.status = "pending";
    l.checkFails = 0;
    return;
  }
  l.status = "done";
  l.notes = [];
  l.checkFails = 0;
  l.failoverFrom = null;
  l.sameReason = 0;
  l.stopRun = 0;
  l.lastReason = null;
  l.failoverNow = false;
  l.tooHard = false;
  l.awaiting = null;
  l.classify = null;
  const m = milestoneOf(s, l.milestone);
  if (m) settle(s, m);
}

const nitLines = (findings: Finding[]): string[] => findings.filter((f) => f.label === "NIT").map(issueLine);

/** The review round's end: counts, keys and what happens next (a fix round, the verifier, or a stop). */
function completeRound(s: RunState, m: MilestoneState): void {
  const seen = new Set<string>();
  const found = m.open.filter((f) => {
    if ((f.label !== "BLOCKER" && f.label !== "BUG") || seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });
  const n = found.length;
  m.counts = [...m.counts, n];
  m.keys = [...m.keys, found.map((f) => findingKey(f.text))];
  const r = m.counts.length;
  m.awaiting = [];
  m.tries = {};
  m.verifierNotes = [];
  if (n === 0) {
    m.open = [];
    m.status = "verifying";
    return;
  }
  const lanes = lanesOf(s, m.id);
  // no progress means not fewer than a round that had findings: a clean review before a verifier FAIL is no baseline
  const before = m.counts[r - 2] ?? 0;
  const previous = new Set(m.keys[r - 2] ?? []);
  const stop = r >= softCap(lanes.length) || (r >= 2 && before > 0 && n >= before);
  if (stop) {
    m.open = found;
    if (found.some((f) => f.label === "BLOCKER")) {
      // BLOCKERs no lane owns dispute the plan, not the code: the triage judge reads them once before the owner does
      const unowned = found.every((f) => f.label !== "BLOCKER" || ownersOf(f, lanes).size === 0);
      if (unowned && m.disputes === 0) {
        m.disputes += 1;
        m.disputing = true;
        m.status = "fixing";
        return;
      }
      m.status = "review";
      s.stuck[m.id] = {
        reason: "blocker",
        question: `${m.id} still has a BLOCKER after ${r} review round(s):\n${found.map((f) => f.text).join("\n")}\nAnswer with the fix to make (one more fix round), or \`accept\` to land with these as known issues.`,
      };
      return;
    }
    m.knownIssues = found.map((f) => f.text);
    m.open = [];
    m.status = "verifying";
    return;
  }
  fixRound(s, m, found, previous, true);
}

/** The lanes a finding goes to: each lane owning a file it names, else the owner of its file. */
function ownersOf(f: Finding, lanes: LaneState[]): Set<string> {
  // a finding naming files of several lanes goes to each of them
  const owners = new Set<string>();
  for (const file of filesOf(f.text)) {
    const o = ownerOfFile(file, lanes);
    if (o) owners.add(o);
  }
  const first = ownerOfFile(f.file, lanes);
  if (owners.size === 0 && first) owners.add(first);
  return owners;
}

/**
 * A fix round: each finding to the lane that owns its file, the rest left open for the judge; `note` to each lane.
 * `blame` (plan 44 D14): the finding is the lane's failure, so its rung is the floor of the fix; a finding that
 * survived the last round's fix makes the floor strict at once, as a same-defect climb did. The owner's answer and
 * a hook refusal blame no one, and the lane starts with no floor.
 */
function fixRound(
  s: RunState,
  m: MilestoneState,
  found: Finding[],
  previous: Set<string>,
  blame: boolean,
  note?: string,
): void {
  const lanes = lanesOf(s, m.id);
  const unowned: Finding[] = [];
  const routed = new Set<LaneState>();
  const survived = new Set<string>();
  for (const f of found) {
    const owners = ownersOf(f, lanes);
    if (owners.size === 0) {
      // the triage judge reads only the finding text, so the note rides in it
      unowned.push(note ? { ...f, text: `${f.text}\n${note}` } : f);
      continue;
    }
    for (const id of owners) {
      const lane = s.lanes[id] as LaneState;
      lane.notes.push(f.text);
      lane.status = "pending";
      lane.checkFails = 0;
      lane.fixedRound = m.counts.length;
      routed.add(lane);
      if (previous.has(findingKey(f.text))) survived.add(lane.id);
    }
  }
  if (note) for (const lane of routed) lane.notes.push(note);
  for (const lane of routed) {
    const name = laneNameOf(lane);
    if (!blame) delete s.floors[name];
    else failedOn(s, name, lane.rung, s.at, survived.has(lane.id));
  }
  m.open = unowned;
  m.status = "fixing";
  settle(s, m);
}

function failRole(
  s: RunState,
  e: Extract<RunEvent, { type: "dispatch.ended" }>,
  m: MilestoneState | undefined,
): void {
  const bad = e.status !== "ok" && e.status !== "limit";
  const refused = e.status === "ok" && (e.replyStatus === "blocked" || e.replyStatus === "refused");
  if (!bad && !refused) return;
  failedOn(s, e.name, s.dispatches[e.dispatchId]?.rung ?? null, e.at);
  if (m) {
    m.tries[e.name] = refused ? MAX_TRIES : (m.tries[e.name] ?? 0) + 1;
    if ((m.tries[e.name] as number) >= MAX_TRIES)
      s.stuck[m.id] = {
        reason: e.name.startsWith("verifier-") ? "verifier" : "effect",
        question: `${e.name} could not finish (${e.status}${e.replyStatus ? `, ${e.replyStatus}` : ""}): ${e.why}`,
      };
    return;
  }
  const key = `ended:${e.name}`;
  s.failedEffects[key] = refused ? MAX_TRIES : (s.failedEffects[key] ?? 0) + 1;
  if ((s.failedEffects[key] as number) >= MAX_TRIES)
    s.stuck[e.unit] = {
      reason: "effect",
      question: `${e.name} could not finish (${e.status}${e.replyStatus ? `, ${e.replyStatus}` : ""}): ${e.why}`,
    };
}

/** A stop that names no reason (plan 30b Ruling 7): the machine asks the decision model for the stop's cause. */
function unexplained(e: Extract<RunEvent, { type: "dispatch.ended" }>): boolean {
  if (e.reason !== null) return false;
  if (e.status === "ok") return e.replyStatus === "blocked" || e.replyStatus === "refused";
  return (e.status === "failed" || e.status === "timeout") && e.environment === null;
}

/** The provider could not be reached (a proxy, the network, an overloaded server): no fault of the lane or its rung. */
const TRANSPORT =
  /ERR_PROXY|couldn't connect|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket hang up|overloaded|\b(?:502|503|504|529)\b/i;

/** A transport failure retries the lane's rung after a backoff as long as the failures have run; HOLD_MS of them parks it. */
function transportHold(s: RunState, l: LaneState, e: Extract<RunEvent, { type: "dispatch.ended" }>): void {
  l.transportSince ??= e.at;
  const elapsed = Date.parse(e.at) - Date.parse(l.transportSince);
  l.status = "pending";
  if (elapsed >= HOLD_MS) {
    l.status = "parked";
    l.transportSince = null;
    s.stuck[l.id] = {
      reason: "provider_error",
      question: stopQuestion(
        l,
        "provider_error",
        `the provider was unreachable for ${Math.round(elapsed / 60_000)} min: ${e.why}`,
      ),
    };
    return;
  }
  s.waiting[e.name] = isoPlus(e.at, Math.min(REFUSAL_WAIT_MS, Math.max(60_000, elapsed)));
  recomputeWake(s);
}

/** plan 43 D21: answerUnit copies the plan inputs from their source again, so an edit of the copy is lost. */
export const SOURCE_PLAN_NOTE =
  "Edit the source plan files, not the run's plan-input copies: catherd copies them again when you answer.";

export const STATUS_ASK =
  "Your last reply had no STATUS: line. If the work is not finished, finish it; then end your reply with STATUS: complete|partial|blocked|refused — <why>.";

export const VERDICT_ASK =
  "Your last reply had no VERDICT line. Do not check again: reply with your verdict on what you already checked, its first line VERDICT: PASS or VERDICT: FAIL, then the lines that verdict asks for.";

const stopQuestion = (l: LaneState, reason: BlockedReason, why: string): string =>
  `${l.id} stopped (${reason})${why.trim() ? `: ${why.trim()}` : ""}`;

/** A lane's stop that names `reason` (spec 2.0 decision 8): the reason decides what happens next. */
function laneStopped(s: RunState, l: LaneState, x: LaneEnd, reason: BlockedReason): void {
  l.stopRun = l.lastReason === reason ? l.stopRun + 1 : 1;
  l.lastReason = reason;
  l.tooHard = false;
  switch (reason) {
    case "needs_user":
      l.thread = x.thread ?? l.thread;
      l.status = "parked";
      l.awaiting = "question";
      return;
    case "too_hard":
      l.thread = null;
      l.status = "pending";
      failedOn(s, laneNameOf(l), x.rung, s.at);
      l.tooHard = true;
      return;
    case "provider_error":
      l.thread = null;
      l.status = "pending";
      // a second one in a row fails over, with no quota hold since no limit was hit; a third parks the lane
      if (l.stopRun === 2) {
        l.failoverFrom = x.rung;
        l.failoverNow = true;
      } else if (l.stopRun >= 3) {
        l.status = "parked";
        s.stuck[l.id] = { reason, question: stopQuestion(l, reason, x.why) };
      }
      return;
    case "check_broken":
      // blames only a sibling's files: the lane did its part
      if (x.foreign.length > 0) return laneDone(s, l);
      l.thread = x.thread ?? l.thread;
      l.status = "pending";
      // the retry has no new input unless a sibling may still change the tree
      if (l.stopRun >= 2 || !siblingMayChange(s, l)) {
        l.status = "parked";
        s.stuck[l.id] = { reason, question: stopQuestion(l, reason, x.why) };
      }
      return;
    case "no_access":
    case "out_of_scope":
      l.thread = x.thread ?? l.thread;
      l.status = "parked";
      s.stuck[l.id] = { reason, question: stopQuestion(l, reason, x.why) };
  }
}

/** Whether `o` follows `id`, directly or through other lanes. */
export function dependsOn(s: RunState, o: LaneState, id: string, seen = new Set<string>()): boolean {
  if (seen.has(o.id)) return false;
  seen.add(o.id);
  return o.after.some((a) => a === id || (s.lanes[a] !== undefined && dependsOn(s, s.lanes[a], id, seen)));
}

/** Whether `o` cannot finish before `id`: it follows `id` or waits on it, directly or through other lanes. */
function holdsFor(s: RunState, o: LaneState, id: string, seen = new Set<string>()): boolean {
  if (seen.has(o.id)) return false;
  seen.add(o.id);
  const next = o.status === "done" ? o.after : [...o.after, ...o.waitOn];
  return next.some((a) => a === id || (s.lanes[a] !== undefined && holdsFor(s, s.lanes[a], id, seen)));
}

/**
 * Whether a sibling of `l`'s milestone is still working or has not tried yet since its last climb: it may be what
 * breaks (or fixes) the check. A sibling that waits on `l`, or that tried and stopped, never counts.
 */
export function siblingMayChange(s: RunState, l: LaneState): boolean {
  return lanesOf(s, l.milestone).some((o) => {
    if (o.id === l.id || dependsOn(s, o, l.id)) return false;
    if (o.status === "running") return true;
    if (o.status !== "pending") return false;
    const tried = Object.values(s.dispatches).filter((d) => d.lane === o.id);
    const latest = tried.at(-1);
    return latest === undefined || (o.floorAt !== null && latest.startedAt < o.floorAt);
  });
}

/**
 * A broken check that names files of siblings not done yet is a wait for them, not a try: the lane checks again
 * once they are. A sibling that follows the lane, or waits on it through any chain, never holds it: that would be a deadlock.
 */
function waitForSiblings(s: RunState, l: LaneState, siblings: string[]): boolean {
  const wait = siblings.filter((id) => {
    const o = s.lanes[id];
    return o !== undefined && id !== l.id && o.status !== "done" && !holdsFor(s, o, l.id);
  });
  if (wait.length === 0) return false;
  l.waitOn = wait;
  l.status = "checking";
  return true;
}

/** One lane dispatch's end, once its stop has a reason (or none): what 1.5 did with it, or the reason's rule. */
function laneEnded(s: RunState, l: LaneState, x: LaneEnd, reason: BlockedReason | null): void {
  if (x.status === "limit") {
    l.status = "pending";
    l.failoverFrom = x.rung;
    l.thread = null;
    return;
  }
  l.waitOn = [];
  const short = x.status === "ok" && (x.replyStatus === "partial" || x.replyStatus === "blocked");
  if ((reason === "check_broken" || (reason === null && short)) && waitForSiblings(s, l, x.siblings)) {
    l.thread = x.thread ?? l.thread;
    return;
  }
  if (x.status === "ok" && x.replyStatus === null && reason === null) {
    // an ok reply with no STATUS is asked for one on the same thread, once; a second is a failed attempt (D8)
    if (!l.statusAsked) {
      l.statusAsked = true;
      l.thread = x.thread ?? l.thread;
      l.notes.push(STATUS_ASK);
    } else {
      l.statusAsked = false;
      l.thread = null;
      failedOn(s, laneNameOf(l), x.rung, s.at);
    }
    l.status = "pending";
    return;
  }
  if (x.replyStatus !== null) l.statusAsked = false;
  if (reason !== null) return laneStopped(s, l, x, reason);
  l.lastReason = null;
  l.stopRun = 0;
  if (x.status === "ok" && (x.replyStatus === "blocked" || x.replyStatus === "refused")) {
    // no reason given, or the decision model unsure: the lane's rung failed it
    l.thread = x.thread ?? l.thread;
    l.status = "pending";
    failedOn(s, laneNameOf(l), x.rung, s.at);
  } else if (x.status === "ok" && x.replyStatus !== "partial") {
    l.thread = x.thread ?? l.thread;
    l.failoverFrom = null;
    l.failoverNow = false;
    if (l.kind === "research") laneDone(s, l);
    else l.status = "checking";
  } else {
    l.thread = null;
    l.status = "pending";
    failedOn(s, laneNameOf(l), x.rung, s.at);
  }
}

/**
 * plan 44 D10: the environment failed the lane, not its work. One repair dispatch on the same thread, counted in no
 * attempt, round or floor; the same signature again parks the lane with the evidence.
 */
function harnessRepair(s: RunState, l: LaneState, evidence: string): void {
  const sig = failureSignature(evidence);
  if (l.harness === sig) {
    l.status = "parked";
    s.stuck[l.id] = {
      reason: "environment",
      question: `${l.id} hit the same environment failure after a repair:\n${evidence}`,
    };
    return;
  }
  l.harness = sig;
  l.notes = [HARNESS_NOTE, evidence];
  l.status = "pending";
}

/** `notes` with the fast check's failure as its one check note. */
const failNotes = (notes: string[], e: Extract<RunEvent, { type: "check.ran" }>): string[] => [
  ...notes.filter((n) => !n.startsWith("The fast check failed")),
  `The fast check failed (exit ${e.exit ?? "timeout"}); its last lines:\n${e.tail}`,
];

/** A verdict on the milestone's commit is in: a verifier's PASS on it, one carried over from an earlier commit, or none owed. */
function verdictIn(m: MilestoneState, carried = false): boolean {
  return carried || m.checkOnly || (m.commit !== null && m.verifierPassedOn === m.commit);
}

/** The check and the verdict on the commit decide the milestone: it lands when both are in, else its verifier is owed. */
function afterVerdict(m: MilestoneState): void {
  m.status = m.commit !== null && m.checkedOn === m.commit && verdictIn(m) ? "landing" : "verifying";
}

/** The owner or the judge accepted a failing check's findings on the commit: the check counts as passed on it, the verdict still decides. */
function waiveCheck(m: MilestoneState): void {
  if (m.commit !== null && m.checkFailedOn === m.commit) m.checkedOn = m.checkWaivedOn = m.commit;
}

/** The base is merged into the milestone's branch: a fresh verifier checks the merge commit. */
function mergedIn(m: MilestoneState, commit: string): void {
  m.commit = commit;
  m.integrateFiles = [];
  m.tries = {};
  m.verifierNotes = [
    `The base branch was merged into the branch at ${commit.slice(0, 12)}: verify that commit.`,
  ];
  m.status = "verifying";
}

/** The rules review is advisory: whatever stops its judge, the run ends without one and is never parked or held. */
function failRulesReview(s: RunState): void {
  delete s.judges.rules;
  s.rulesReview = { changes: [], failed: true };
}

function onEnded(s: RunState, e: Extract<RunEvent, { type: "dispatch.ended" }>): void {
  const dv = s.dispatches[e.dispatchId];
  if (!dv) return;
  dv.thread = e.thread ?? dv.thread;
  dv.ended = { at: e.at, status: e.status, replyStatus: e.replyStatus, reason: e.reason };
  const rung = tryParseRung(dv.rung);
  if (rung) {
    const quota = quotaOf(rung);
    if (e.status === "limit") s.holds[quota] = isoPlus(e.at, HOLD_MS);
    else if (e.status === "ok" && e.replyStatus === "complete") delete s.holds[quota];
  }
  recomputeWake(s);
  if (dv.role === "judge") {
    if (e.status === "limit" && dv.name === judgeName("rules")) failRulesReview(s);
    return;
  }
  const lane = dv.lane ? s.lanes[dv.lane] : undefined;
  if (lane) {
    const x: LaneEnd = {
      rung: dv.rung,
      status: e.status,
      replyStatus: e.replyStatus,
      thread: e.thread,
      why: e.why,
      foreign: e.foreign,
      siblings: e.siblings ?? [],
    };
    if ((e.status === "failed" || e.status === "timeout") && TRANSPORT.test(e.why))
      return transportHold(s, lane, e);
    lane.transportSince = null;
    // every lane stop waits for its class (and its reason, when it names none): nothing else happens to the lane meanwhile
    if (e.status !== "limit" && (e.reason !== null || unexplained(e))) {
      lane.classify = { dispatchId: e.dispatchId, reason: e.reason, ...x };
      return;
    }
    laneEnded(s, lane, x, e.reason);
    return;
  }
  const m = milestoneOf(s, e.unit);
  if (dv.role === "architect") {
    if (e.status === "ok" && e.replyStatus !== "blocked" && e.replyStatus !== "refused") s.planDirty = true;
    else failRole(s, e, m);
    return;
  }
  if (!m) {
    if (e.status === "ok" && e.replyStatus !== "blocked" && e.replyStatus !== "refused") accepted(s, e.name);
    failRole(s, e, undefined);
    return;
  }
  if (e.name === integrateName(m.id) && m.status === "integrating") {
    const refused = e.replyStatus === "blocked" || e.replyStatus === "refused";
    if (e.status === "ok" && !refused) {
      accepted(s, e.name);
      m.status = "committing";
    } else failRole(s, e, m);
    return;
  }
  if ((dv.role === "reviewer" || dv.role === "ui-reviewer") && m.status === "review") {
    if (e.status === "ok" && e.replyStatus !== "blocked" && e.replyStatus !== "refused") {
      accepted(s, e.name);
      m.open.push(...e.findings);
      m.nits.push(...nitLines(e.findings));
      if (e.replyStatus === "partial" && e.name === `reviewer-${m.id}`)
        m.awaiting = m.awaiting.map((n) => (n === e.name ? `reviewer-${m.id}-2` : n));
      else m.awaiting = m.awaiting.filter((n) => n !== e.name);
      if (m.awaiting.length === 0) completeRound(s, m);
    } else failRole(s, e, m);
    return;
  }
  if (dv.role === "verifier" && m.status === "verifying") {
    const asked = m.verdictAsk;
    m.verdictAsk = null;
    // a verdict is taken: no floor holds the verifier's next dispatch
    if (e.status === "ok" && e.verdict !== null && !e.noVerdict) accepted(s, e.name);
    // A broken check needs the owner before another verifier can learn anything.
    if (e.status === "ok" && e.reason === "check_broken" && e.verdict !== "blocked") {
      m.verifierFailedOn = m.commit;
      s.stuck[m.id] = {
        reason: "check_broken",
        question: `${e.name} could not run the check: ${e.why || "no reason given"}. Answer accept to land on catherd's green Check, retry to run the verifier again, or name the fix.`,
      };
    } else if (e.status === "ok" && e.verdict === "pass") {
      m.verifierRuns += 1;
      // a PASS about another commit than the milestone's is no verdict on it: a fresh verifier checks the right one
      if (m.commit !== null && e.head !== null && m.commit.startsWith(e.head)) {
        m.verifierPassedOn = m.commit;
        // dedup before the prefix: a verifier NIT a reviewer already named is listed once, unprefixed
        const known = new Set([...m.knownIssues, ...m.nits]);
        const own = nitLines(e.findings).filter((l) => !known.has(l));
        m.knownIssues = [...new Set([...known, ...own.map((l) => `${e.name}: ${l}`)])];
        m.tries = {};
        m.verifierNotes = [];
        m.status = "landing";
      } else {
        m.tries[e.name] = (m.tries[e.name] ?? 0) + 1;
        const at = (m.commit ?? "HEAD").slice(0, 12);
        m.verifierNotes = [
          `verify ${at}: your last verdict was about ${e.head ? e.head.slice(0, 12) : "no commit"}; check commit ${at} and end your reply with HEAD: <the full sha you checked>.`,
        ];
        if ((m.tries[e.name] as number) >= MAX_TRIES)
          s.stuck[m.id] = {
            reason: "verifier",
            question: `${e.name} passed ${e.head ? e.head.slice(0, 12) : "no commit"} twice, and the milestone is at ${at}`,
          };
      }
    } else if (e.status === "ok" && e.verdict === "fail" && e.noVerdict && asked === null && e.thread) {
      // a reply that stopped before its VERDICT line is asked for it on the same thread, once (plan 43 D8's rule)
      m.verdictAsk = e.thread;
      m.verifierNotes = [VERDICT_ASK];
    } else if (e.status === "ok" && e.verdict === "fail") {
      m.verifierFailedOn = m.commit;
      m.verifierRuns += 1;
      m.open = e.findings.length
        ? e.findings.map((f) => ({ ...f, label: "BLOCKER" as const }))
        : [{ label: "BLOCKER", text: `FAIL: ${e.why || "the verifier failed the milestone"}`, file: null }];
      completeRound(s, m);
    } else if (e.status === "ok" && e.verdict === "blocked") {
      m.verifierFailedOn = m.commit;
      m.verifierRuns += 1;
      s.stuck[m.id] = {
        reason: "environment",
        question: `${e.name} is blocked by the environment: ${e.environment || e.why || "no probe named"}`,
      };
    } else failRole(s, e, m);
  }
}

function onClimbed(s: RunState, e: Extract<RunEvent, { type: "lane.climbed" }>): void {
  const l = s.lanes[e.lane];
  if (!l) return;
  const tooHard = l.tooHard;
  l.rung = e.rung;
  l.top = e.top;
  l.thread = null;
  l.checkFails = 0;
  l.failoverFrom = null;
  l.failoverNow = false;
  l.tooHard = false;
  l.stopRun = 0;
  l.floorAt = e.at;
  if (e.top) topOfLadder(s, l, e.rung, tooHard);
  else l.status = "pending";
  const m = milestoneOf(s, l.milestone);
  if (m?.status === "fixing") l.fixedRound = m.counts.length;
}

/** A lane with no rung left above its floor: parked for the judge, the owner after TOP_RUNG_JUDGES, or at once for a too_hard stop. */
function topOfLadder(s: RunState, l: LaneState, rung: string, tooHard: boolean): void {
  l.status = "parked";
  l.sameReason += 1;
  if (tooHard)
    // a stronger model was the only fix, and there is none: the owner decides
    s.stuck[l.id] = {
      reason: "too_hard",
      question: `${l.id} is too hard for its top rung (${rung}); no stronger model is left`,
    };
  else {
    l.awaiting = "unexpected";
    if (l.sameReason >= TOP_RUNG_JUDGES)
      s.stuck[l.id] = {
        reason: "too_hard",
        question: `${l.id} is at the top rung and still does not get through; the judge was asked ${l.sameReason} times`,
      };
  }
}

/** plan 44 D15: a strict floor with no rung above it is the top of the ladder for a lane, a parked unit for any other name. */
function onExhausted(s: RunState, e: Extract<RunEvent, { type: "decision.exhausted" }>): void {
  if (e.name === judgeName("rules")) return failRulesReview(s);
  const l = s.lanes[e.unit];
  if (l && e.name === laneNameOf(l)) {
    const tooHard = l.tooHard;
    l.top = true;
    l.thread = null;
    l.checkFails = 0;
    l.failoverFrom = null;
    l.failoverNow = false;
    l.tooHard = false;
    l.stopRun = 0;
    topOfLadder(s, l, e.floor, tooHard);
    return;
  }
  s.exhaustedParks[e.unit] = e.name;
  s.stuck[e.unit] = {
    reason: "effect",
    question: `${e.name} failed on ${e.floor} and no rung above it is left to try.`,
  };
}

/** New notes change a unit's briefs: a decision made before them judged a brief that is stale now. */
function forgetDecisions(s: RunState, unit: string): void {
  for (const name of Object.keys(s.decisions))
    if (name.endsWith(`-${unit}`) || name.includes(`-${unit}-`)) delete s.decisions[name];
}

function onJudged(s: RunState, e: Extract<RunEvent, { type: "judge.decided" }>): void {
  delete s.judges[e.id];
  accepted(s, judgeName(e.id));
  const d = e.decision;
  const lane = s.lanes[e.unit];
  const m = milestoneOf(s, e.unit);
  // a dispute gets one judge call: whatever it decides, the milestone is no longer disputing
  const disputing = m?.disputing ?? false;
  if (m) m.disputing = false;
  switch (d.verb) {
    case "route": {
      if (!m) return;
      const lanes = lanesOf(s, m.id);
      const sent = new Set<number>();
      for (const r of d.routes) {
        const f = m.open[r.finding - 1];
        if (!f) continue;
        const target = lanes.find((l) => l.id === r.to);
        if (target) {
          sent.add(r.finding);
          // a running or checking lane keeps the route for its next try: cancelling the try could undo its own fix
          if (target.status === "running" || target.status === "checking") {
            target.queued.push(f.text);
            continue;
          }
          target.notes.push(f.text);
          forgetDecisions(s, target.id);
          target.status = "pending";
          target.fixedRound = m.counts.length;
        } else if (r.to === "architect") {
          sent.add(r.finding);
          m.delta.push(f.text);
        }
      }
      // a dismissal of every finding of a verifier FAIL with no fix left to run would recommit the failed commit
      const overrule =
        sent.size === 0 &&
        m.commit !== null &&
        m.verifierFailedOn === m.commit &&
        m.delta.length === 0 &&
        lanes.every((l) => l.status === "done");
      if (disputing || overrule) {
        // what the judge sends nowhere is dismissed: a known issue of the milestone it lands
        m.open.forEach((f, i) => {
          if (!sent.has(i + 1)) m.knownIssues.push(`dismissed by the judge: ${f.text}`);
        });
        if (sent.size === 0) {
          // the judge overrules a verifier's FAIL on this commit: the commit's verdict is a PASS
          if (m.commit !== null && m.verifierFailedOn === m.commit) {
            m.verifierPassedOn = m.commit;
            m.verifierFailedOn = null;
            // the verdict the judge overruled was the verifier's failure (D14)
            const verifier = lastOf(s, `verifier-${m.id}`);
            if (verifier) failedOn(s, verifier.name, verifier.rung, e.at);
          }
          waiveCheck(m);
          m.open = [];
          afterVerdict(m);
          return;
        }
      }
      m.open = [];
      settle(s, m);
      return;
    }
    case "answer":
      if (lane) {
        lane.notes.push(`The judge answered: ${d.answer}`);
        forgetDecisions(s, lane.id);
        lane.status = "pending";
        lane.awaiting = null;
        relaxTop(s, lane);
      }
      return;
    case "ask_owner":
    case "park":
      s.stuck[e.unit] = { reason: d.verb === "park" ? "judge" : "needs_user", question: d.question };
      return;
    case "retry":
      if (lane) {
        lane.status = "pending";
        lane.awaiting = null;
        relaxTop(s, lane);
      }
      return;
    case "climb":
      if (lane) {
        lane.status = "pending";
        lane.awaiting = null;
        // the judge's climb: the lane's rung failed it, so the floor is the next rung above
        failedOn(s, laneNameOf(lane), lane.rung, e.at, true);
      }
      return;
    case "skip":
      if (lane) {
        const lm = milestoneOf(s, lane.milestone);
        lm?.knownIssues.push(`${lane.id} skipped: ${d.why}`);
        lane.queued = [];
        laneDone(s, lane);
      }
      return;
    case "rules":
      s.rulesReview = { changes: d.changes, failed: false };
  }
}

/** A judge's retry or answer at the top of the ladder runs the lane's last rung again: its floor is no longer strict. */
function relaxTop(s: RunState, l: LaneState): void {
  const f = s.floors[laneNameOf(l)];
  if (l.top && f) f.fails = 0;
}

const RETRY = /^\s*retry\b/i;

/**
 * plan 44 D16: the coordinator's answer to a parked decision. A listed rung is the pick, `retry` clears the count and
 * asks the model again, and anything else parks the same question again. A parked classification ends the stop as
 * unclassified (a failure of the work) unless the answer is `retry`.
 */
function onDecisionAnswered(
  s: RunState,
  e: Extract<RunEvent, { type: "question.answered" }>,
  q: OpenQuestion,
): void {
  const name = s.decisionParks[e.unit] ?? "";
  delete s.decisionParks[e.unit];
  const word = (e.answer.trim().split(/\s+/)[0] ?? "").replace(/^[`'"*]+|[`'".,;:*]+$/g, "");
  const retry = RETRY.test(e.answer);
  const rungs = s.decisionRungs[name] ?? [];
  const lane = s.lanes[e.unit];
  const resume = (): void => {
    delete s.decisionFails[name];
    delete s.waiting[name];
    delete s.decisionRungs[name];
    // a worker's lane runs again; a judge's lane stays parked for the judge, a milestone goes back where it stood
    if (lane && !name.startsWith("judge-")) lane.status = "pending";
    else {
      const m = milestoneOf(s, e.unit);
      if (m && m.status === "parked") {
        m.status = m.parkedFrom ?? "waiting";
        m.parkedFrom = null;
      }
    }
  };
  // no name to answer for (a park whose state is gone): the unit just goes on
  if (name === "") return resume();
  if (name.startsWith("classify:")) {
    delete s.decisionFails[name];
    delete s.waiting[name];
    delete s.decisionRungs[name];
    if (retry) {
      if (lane) lane.status = "pending";
      return;
    }
    if (lane?.classify) {
      const { dispatchId: _id, reason, ...x } = lane.classify;
      lane.classify = null;
      lane.status = "pending";
      laneEnded(s, lane, x, reason ?? null);
    }
    return;
  }
  if (retry) {
    delete s.picks[name];
    return resume();
  }
  if (rungs.includes(word)) {
    s.picks[name] = word;
    return resume();
  }
  s.decisionParks[e.unit] = name;
  s.stuck[e.unit] = { reason: "decision", question: q.question };
}

function onAnswered(s: RunState, e: Extract<RunEvent, { type: "question.answered" }>): void {
  const q = s.questions[e.unit];
  delete s.questions[e.unit];
  recomputeWake(s);
  delete s.stuck[e.unit];
  // the owner's word starts a name that ran out of rungs fresh, as it does a lane
  delete s.floors[s.exhaustedParks[e.unit] ?? ""];
  delete s.exhaustedParks[e.unit];
  for (const k of Object.keys(s.failedEffects))
    if (k.endsWith(`@${e.unit}`) || k === `ended:${e.unit}`) delete s.failedEffects[k];
  if (q?.reason === "decision") return onDecisionAnswered(s, e, q);
  const lane = s.lanes[e.unit];
  if (lane) {
    // the owner's word starts the lane fresh: no rung failed it
    delete s.floors[laneNameOf(lane)];
    lane.notes.push(`The owner answered: ${e.answer}`);
    forgetDecisions(s, lane.id);
    lane.status = "pending";
    lane.checkFails = 0;
    lane.sameReason = 0;
    lane.stopRun = 0;
    lane.lastReason = null;
    lane.failoverNow = false;
    lane.awaiting = null;
    return;
  }
  const m = milestoneOf(s, e.unit);
  if (!m) {
    for (const k of Object.keys(s.failedEffects)) if (k.startsWith("ended:")) delete s.failedEffects[k];
    if (e.unit === RUN_UNIT) {
      if (q?.reason === "approval") s.revise = [`The owner asked for these changes to plan.md: ${e.answer}`];
      else s.notes.push(`The owner answered: ${e.answer}`);
    }
    return;
  }
  // the owner's word that a push question's milestone is merged: how a squash merge unblocks its dependants
  // plan 35: the word `push` is no merge: catherd pushes the branch and asks again
  if (q?.reason === "push") {
    if (m.status !== "landed") return;
    if (isPushAnswer(e.answer)) m.pushing = true;
    else m.status = "merged";
    return;
  }
  // read before the answer clears it: an accept after a verifier FAIL on this commit stands for the verifier's PASS
  const failedHere = m.commit !== null && m.verifierFailedOn === m.commit;
  m.verifierFailedOn = null;
  m.notes.push(`The owner answered: ${e.answer}`);
  forgetDecisions(s, m.id);
  const from = m.parkedFrom ?? "waiting";
  m.parkedFrom = null;
  m.tries = {};
  if (from === "routing") {
    m.status = "waiting";
    m.confirmed = true;
  } else if (q?.reason === "blocker" && isAccept(e.answer)) {
    if (failedHere) m.verifierPassedOn = m.commit;
    waiveCheck(m);
    m.knownIssues = m.open.map((f) => f.text);
    m.open = [];
    afterVerdict(m);
  } else if (q?.reason === "land" && from === "verifying" && isAccept(e.answer)) {
    // the check's missing lines are waived for this commit: known issues, and the check counts as passed on it
    m.knownIssues = [...m.knownIssues, ...m.open.map((f) => f.text)];
    m.open = [];
    m.checkedOn = m.commit;
    afterVerdict(m);
  } else if (q?.reason === "check_broken" && from === "verifying" && isAccept(e.answer)) {
    // the machine Check is green on this commit: the owner's accept stands for the verifier that could not run
    if (m.commit !== null && m.checkedOn === m.commit) m.verifierPassedOn = m.commit;
    afterVerdict(m);
  } else if (q?.reason === "blocker")
    // the owner's answer is the fix: one more round, no climb; the cap applies again only at its review's end
    fixRound(s, m, m.open, new Set(), false, `The owner answered: ${e.answer}`);
  else if (
    (q?.reason === "land" || q?.reason === "check_broken") &&
    !isAccept(e.answer) &&
    !RETRY.test(e.answer)
  )
    // anything but accept or retry names the fix: one BLOCKER, routed by the files it names, else to the triage judge
    fixRound(s, m, [{ label: "BLOCKER", text: e.answer, file: null }], new Set(), false);
  else m.status = from;
}

/** Every quota is held (a refused dispatch, or a limit's failover with no stand-in free): wait for the earliest hold to end. */
function allHeld(s: RunState, name: string, unit: string, at: string): void {
  const l = s.lanes[unit];
  const heldUntil = Object.values(s.holds)
    .filter((u) => u > at)
    .sort()[0];
  // a repeated provider_error holds no quota: with no stand-in free either, waiting would never end
  if (l?.failoverNow && heldUntil === undefined) {
    l.status = "parked";
    s.stuck[l.id] = {
      reason: "provider_error",
      question: stopQuestion(l, "provider_error", "no stand-in rung is free"),
    };
    return;
  }
  s.waiting[name] = heldUntil ?? isoPlus(at, REFUSAL_WAIT_MS);
  recomputeWake(s);
}

/** One event applied to `s` in place. */
function apply(s: RunState, e: RunEvent): void {
  s.seq = e.seq;
  s.at = e.at;
  const ok = (key: string) => delete s.failedEffects[key];
  switch (e.type) {
    case "run.started":
      s.title = e.title;
      s.base = e.base;
      s.aLines = e.aLines;
      s.plan = e.plan;
      s.rolesOff = e.rolesOff ?? [];
      s.autoMerge = e.autoMerge ?? false;
      return;
    case "plan.ready":
      mergePlan(s, e.milestones);
      // the architect's plan is read: no floor holds its next dispatch
      for (const k of Object.keys(s.floors))
        if (k === "architect" || k.startsWith("architect-")) delete s.floors[k];
      // a plan the owner did not give waits for the owner's approval before its first lane
      if (s.phase === "planning") s.phase = hasPlanInput(s) ? "running" : "approval";
      s.planDirty = false;
      s.revise = [];
      ok(`readPlan@${RUN_UNIT}`);
      for (const m of s.milestones) settle(s, m);
      return;
    case "plan.approved":
      if (s.phase === "approval") s.phase = "running";
      if (s.questions[RUN_UNIT]?.reason === "approval") delete s.questions[RUN_UNIT];
      recomputeWake(s);
      s.revise = [];
      return;
    case "lanes.routed": {
      for (const r of e.lanes) {
        const l = s.lanes[r.lane];
        if (l) l.rung = r.rung;
      }
      const m = milestoneOf(s, e.milestone);
      if (m?.status === "waiting") m.status = "routing";
      return;
    }
    case "preflight.done": {
      ok(`route@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (!m || m.status !== "routing") return;
      if (e.blocking.length > 0)
        s.stuck[m.id] = {
          reason: "preflight",
          question: `Preflight cannot start these lanes:\n${e.blocking.map((b) => `${b.lane}: ${b.note}`).join("\n")}`,
        };
      else if (e.confirm && e.confirm.length > 0)
        s.stuck[m.id] = {
          reason: "confirm",
          question: `Confirm these fast checks may run:\n${e.confirm.join("\n")}`,
        };
      else {
        m.status = "lanes";
        settle(s, m);
      }
      return;
    }
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
        ended: null,
      };
      delete s.waiting[e.name];
      recomputeWake(s);
      const asking = e.role === "verifier" ? milestoneOf(s, e.unit) : undefined;
      if (asking?.verdictAsk && asking.verdictAsk !== e.thread) {
        asking.verdictAsk = null;
        asking.verifierNotes = asking.verifierNotes.filter((n) => n !== VERDICT_ASK);
      }
      ok(`dispatch@${e.unit}`);
      ok(`duplicate:${e.name}@${e.unit}`);
      ok(`admit:${e.name}@${e.unit}`);
      ok(`redecide:${e.name}@${e.unit}`);
      if (e.role === "judge") {
        ok(`judge@${e.unit}`);
        const id = e.name.replace(/^judge-/, "");
        s.judges[id] = { unit: e.unit, kind: e.judgeKind ?? "unexpected", tries: s.judges[id]?.tries ?? 0 };
      }
      // the decision is spent: the next dispatch of the name is decided again (D13)
      delete s.decisions[e.name];
      delete s.refusedRungs[e.name];
      delete s.picks[e.name];
      const l = e.lane ? s.lanes[e.lane] : undefined;
      if (l && e.role !== "judge") l.rung = e.rung;
      if (l && (l.status === "pending" || l.status === "checking")) l.status = "running";
      return;
    }
    case "dispatch.refused": {
      const wait = (until: string) => {
        s.waiting[e.name] = until;
        recomputeWake(s);
      };
      if (e.code === "E_RUN_CANCELLED") return;
      // the rules review is advisory: a refusal of its judge ends it, a decision to drop included
      if (e.name === judgeName("rules") && e.unit === RUN_UNIT) return failRulesReview(s);
      if (e.code === "E_DECISION_STALE" || e.code === "E_RUNG_HELD" || e.code === "E_ADMIT_RUNG") {
        // D18: the decision is dropped and made again; a refused rung leaves the next list, a held quota is out already
        delete s.decisions[e.name];
        if (e.code === "E_ADMIT_RUNG" && e.rung)
          s.refusedRungs[e.name] = [...new Set([...(s.refusedRungs[e.name] ?? []), e.rung])];
        const key = `redecide:${e.name}@${e.unit}`;
        s.failedEffects[key] = (s.failedEffects[key] ?? 0) + 1;
        if ((s.failedEffects[key] as number) >= REDECIDE_LIMIT)
          s.stuck[e.unit] = {
            reason: "effect",
            question: `${e.name} was refused (${e.code}) ${REDECIDE_LIMIT} times: ${e.message}`,
          };
        return;
      }
      if (e.code === "E_RUN_BUDGET")
        s.stuck[RUN_UNIT] = { reason: "budget", question: `The run budget is spent: ${e.message}` };
      else if (e.code === "E_ADMIT_PAUSED") s.held ??= e.at;
      else if (e.code === "E_ALL_HELD") allHeld(s, e.name, e.unit, e.at);
      else if (e.code === "E_ADMIT_ORDER" || e.code === "E_ADMIT_OVERLAP") {
        const key = `admit:${e.name}@${e.unit}`;
        s.failedEffects[key] = (s.failedEffects[key] ?? 0) + 1;
        if ((s.failedEffects[key] as number) >= ADMIT_WAITS)
          s.stuck[e.unit] = { reason: "effect", question: `${e.name} was refused (${e.code}): ${e.message}` };
        else wait(isoPlus(e.at, REFUSAL_WAIT_MS));
      } else if (e.code === "E_ADMIT_DUPLICATE") {
        const key = `duplicate:${e.name}@${e.unit}`;
        s.failedEffects[key] = (s.failedEffects[key] ?? 0) + 1;
        if ((s.failedEffects[key] as number) >= DUPLICATE_LIMIT)
          s.stuck[e.unit] = { reason: "effect", question: `${e.name} was refused (${e.code}): ${e.message}` };
        else wait(isoPlus(e.at, REFUSAL_WAIT_MS));
      } else
        s.stuck[e.unit] = { reason: "effect", question: `${e.name} was refused (${e.code}): ${e.message}` };
      return;
    }
    case "dispatch.ended":
      onEnded(s, e);
      return;
    case "check.ran": {
      ok(`fastCheck@${e.lane}`);
      const l = s.lanes[e.lane];
      if (!l) return;
      l.waitOn = [];
      // a check that fails only in a sibling's files has nothing to say about this lane
      if (e.exit !== 0 && waitForSiblings(s, l, e.siblings ?? [])) return;
      if (e.exit === 0 || e.foreign.length > 0) {
        l.lastFails = null;
        l.lastFailHead = null;
        l.harness = null;
        laneDone(s, l);
      } else if (e.failureClass === "harness") {
        harnessRepair(s, l, e.tail);
      } else {
        l.harness = null;
        const fails = checkFailLines(e.tail);
        const key = e.tree !== undefined ? e.tree : (milestoneOf(s, l.milestone)?.commit ?? null);
        if (
          fails.length > 0 &&
          fails.length === l.lastFails?.length &&
          fails.every((line, i) => line === l.lastFails?.[i]) &&
          key === l.lastFailHead &&
          e.tree !== null
        ) {
          s.stuck[e.lane] = {
            reason: "environment",
            question: `${e.lane} repeated the same check failure on an unchanged head:\n${fails.join("\n")}`,
          };
          return;
        }
        l.lastFails = fails;
        l.lastFailHead = key;
        l.checkFails += 1;
        l.notes = failNotes(l.notes, e);
        l.status = "pending";
        // the failed check is the failure of the rung that ran: it is the floor of the fix round
        failedOn(s, laneNameOf(l), l.rung, e.at);
      }
      return;
    }
    case "milestone.checked": {
      const m = milestoneOf(s, e.milestone);
      // a check of another commit, or of a commit the milestone has left, is no verdict on this one
      if (m?.status !== "verifying" || m.commit !== e.head) return;
      ok(`machineCheck@${e.milestone}`);
      m.uncovered = e.uncovered;
      m.checkOnly = e.checkOnly;
      if (e.findings.length > 0) {
        // the failing lines are a fix round for their lanes: no verifier is asked about a commit the check fails
        m.checkedOn = null;
        m.checkFailedOn = e.head;
        m.open = e.findings;
        completeRound(s, m);
        // findings that ended the round as known issues, or as none, are settled: the check does not run again here
        if (m.status === "verifying") {
          m.checkedOn = e.head;
          afterVerdict(m);
        }
        return;
      }
      if (e.missing.length > 0) {
        m.checkedOn = null;
        m.open = e.missing.map((text) => ({ label: "BUG" as const, text, file: null }));
        s.stuck[m.id] = {
          reason: "land",
          question: `${m.id}'s check fails on lines with no baseline:\n${e.missing.join("\n")}\nanswer accept to land with these pre-existing failures, retry to run the check again, or name the fix.`,
        };
        return;
      }
      m.checkedOn = e.head;
      m.checkFailedOn = null;
      m.open = [];
      if (verdictIn(m, e.verdictCarried)) {
        m.tries = {};
        m.verifierNotes = [];
        m.status = "landing";
      }
      return;
    }
    case "commit.made": {
      ok(`commit@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (!m) return;
      // the commit that finishes a merge of the base: reviews stay (by time), a fresh verifier gates the merge
      if (m.integrateFiles.length > 0) return mergedIn(m, e.commit);
      m.hookFixes = 0;
      m.status = "review";
      m.round = e.round;
      m.commit = e.commit;
      m.open = [];
      m.nits = [];
      m.tries = {};
      m.awaiting = reviewersOf(s, m);
      if (m.awaiting.length === 0) completeRound(s, m);
      return;
    }
    case "commit.failed": {
      ok(`commit@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (e.hook && m && m.hookFixes === 0) {
        // the first hook refusal of a round is the lanes' to fix, routed by the files it names
        m.hookFixes = 1;
        const text = `The pre-commit hook refused the commit:\n${e.tail}`;
        fixRound(s, m, [{ label: "BLOCKER", text, file: filesOf(e.tail)[0] ?? null }], new Set(), false);
        return;
      }
      s.stuck[e.milestone] = {
        reason: "commit",
        question: `Committing ${e.milestone} failed (round ${e.round}):\n${e.tail}`,
      };
      return;
    }
    case "decision.made": {
      s.decisions[e.name] = {
        n: e.n,
        rung: e.rung,
        briefFile: e.briefFile,
        briefHash: e.briefHash,
        source: e.source,
      };
      s.decided[e.name] = e.n;
      ok(`decide@${e.unit}`);
      delete s.decisionFails[e.name];
      delete s.picks[e.name];
      delete s.waiting[e.name];
      recomputeWake(s);
      const l = s.lanes[e.unit];
      if (l && e.name === laneNameOf(l)) l.rung = e.rung;
      return;
    }
    case "decision.failed":
      ok(`decide@${e.unit}`);
      // the rules review is advisory: a decision it cannot get ends it, as a refused dispatch does
      if (
        e.name === judgeName("rules") &&
        (e.code === "E_ALL_HELD" || (s.decisionFails[e.name] ?? 0) + 1 >= DECISION_TRIES)
      )
        failRulesReview(s);
      else if (e.code === "E_ALL_HELD") allHeld(s, e.name, e.unit, e.at);
      else
        decisionFailed(s, {
          name: e.name,
          unit: e.unit,
          at: e.at,
          error: e.error,
          rungs: e.rungs,
          ...(s.lanes[e.unit] ? { lane: s.lanes[e.unit] as LaneState } : {}),
        });
      return;
    case "decision.exhausted":
      onExhausted(s, e);
      return;
    case "lane.climbed":
      ok(`climb@${e.lane}`);
      onClimbed(s, e);
      return;
    case "judge.decided":
      onJudged(s, e);
      return;
    case "judge.failed": {
      const j = s.judges[e.id];
      if (!j) return;
      const last = lastOf(s, judgeName(e.id));
      if (last) failedOn(s, last.name, last.rung, e.at);
      j.tries += 1;
      if (j.tries >= MAX_TRIES) {
        delete s.judges[e.id];
        // the rules review is advisory: a judge that cannot answer ends the run without one, never parks it
        if (j.kind === "rules") s.rulesReview = { changes: [], failed: true };
        else
          s.stuck[e.unit] = { reason: "judge", question: `The judge could not decide ${e.unit}: ${e.why}` };
      }
      return;
    }
    case "question.parked": {
      s.questions[e.unit] = { unit: e.unit, question: e.question, reason: e.reason, at: e.at, reminded: 0 };
      recomputeWake(s);
      delete s.stuck[e.unit];
      for (const [id, j] of Object.entries(s.judges)) if (j.unit === e.unit) delete s.judges[id];
      s.owed[`parked:${e.unit}`] = {
        kind: "parked",
        unit: e.unit,
        text: `${e.unit} is parked (${e.reason}): ${e.question}`,
        moment: "blocked",
      };
      const l = s.lanes[e.unit];
      const m = milestoneOf(s, e.unit);
      // an architect change that edits an approved decision asks the owner again: no new lane until they answer
      if (e.unit === RUN_UNIT && e.reason === "approval" && (s.phase === "planning" || s.phase === "running"))
        s.phase = "approval";
      if (l) l.status = "parked";
      else if (m && e.reason !== "push" && m.status !== "parked") {
        m.parkedFrom = m.status;
        m.status = "parked";
      }
      return;
    }
    case "question.reminded": {
      const q = s.questions[e.unit];
      if (q && e.n > q.reminded) {
        q.reminded = e.n;
        q.remindedAt = e.at;
      }
      ok(`remind@${e.unit}`);
      recomputeWake(s);
      return;
    }
    case "question.answered":
      onAnswered(s, e);
      return;
    case "milestone.landed": {
      ok(`land@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m) {
        m.status = "landed";
        m.commit = e.commit;
        m.knownIssues = e.knownIssues;
        m.open = [];
        m.awaiting = [];
        m.branch = e.branch ?? null;
        m.digestPath = e.digestPath;
        m.mergeDue = s.base === null ? null : isoPlus(e.at, MERGE_CHECK_MS);
        recomputeWake(s);
      }
      s.owed[`landed:${e.milestone}`] = {
        kind: "landed",
        unit: e.milestone,
        text: `${e.milestone} landed at ${e.commit.slice(0, 7)}${
          e.knownIssues.length ? `, with ${e.knownIssues.length} known issue(s)` : ""
        }: ${m?.title ?? ""}`.trimEnd(),
        moment: "milestone",
      };
      return;
    }
    case "land.refused": {
      ok(`land@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m) m.landRefusals += 1;
      // the first refusal reruns the check on the commit, the verdict it has stands; the second parks
      if (m?.status === "landing" && m.landRefusals === 1) {
        m.status = "verifying";
        m.checkedOn = null;
        m.tries = {};
        m.verifierNotes = [
          `A landing of this milestone was refused (${e.code}): ${e.message}`,
          `Fix: ${e.fix}`,
        ];
        return;
      }
      s.stuck[e.milestone] = {
        reason: "land",
        question: `Landing ${e.milestone} was refused (${e.code}): ${e.message}\nFix: ${e.fix}\nAnswer accept or retry to land again, or name the fix.`,
      };
      return;
    }
    case "milestone.merged": {
      const m = milestoneOf(s, e.milestone);
      if (m) {
        m.status = "merged";
        m.mergeDue = null;
        m.mergeError = null;
      }
      if (s.questions[e.milestone]?.reason === "push") delete s.questions[e.milestone];
      recomputeWake(s);
      return;
    }
    case "merge.failed": {
      const m = milestoneOf(s, e.milestone);
      if (m) m.mergeError = e.error;
      return;
    }
    case "tree.ready": {
      ok(`claimTree@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m) {
        if (m.memoryWaitSince !== null) {
          s.owed[`memory:${e.milestone}`] = {
            kind: "memory",
            unit: e.milestone,
            text: `${e.milestone} has its worktree, after waiting for memory since ${m.memoryWaitSince}`,
            moment: null,
          };
          m.memoryWaitSince = null;
        }
        m.tree = e.tree;
        m.branch = e.branch;
        m.treeAt = e.at;
        m.claimAfter = null;
      }
      recomputeWake(s);
      return;
    }
    case "tree.deferred": {
      ok(`claimTree@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m) {
        m.claimAfter = isoPlus(e.at, MEMORY_LIMITS.recheckMs);
        if (m.memoryWaitSince === null) {
          m.memoryWaitSince = e.at;
          s.owed[`memory:${e.milestone}`] = {
            kind: "memory",
            unit: e.milestone,
            text: `${e.milestone} waits for ${e.resource ?? "memory"}: ${e.availableMb} MB available, ${e.needMb} MB needed; catherd looks again every ${MEMORY_LIMITS.recheckMs / 60_000} minutes`,
            moment: null,
          };
        }
      }
      recomputeWake(s);
      return;
    }
    case "branch.pushed": {
      ok(`pushBranch@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m) {
        m.pushing = false;
        m.mr = e.mr;
      }
      return;
    }
    case "cancel.requested":
      s.cancelling = true;
      return;
    case "run.paused":
      s.paused ??= e.at;
      return;
    case "run.resumed":
      s.paused = null;
      return;
    case "pause.lifted":
      s.held = null;
      recomputeWake(s);
      return;
    case "effect.failed": {
      if (e.action === "readPlan") s.planDirty = false;
      if (e.action === "classify") {
        // plan 44 D16: a classification that cannot be made is a decision failure of its own name: tried again after a
        // wait, the lane parked at the third, and the owner's answer ends the stop as unclassified
        const l = s.lanes[e.unit];
        if (l?.classify)
          decisionFailed(s, {
            name: `classify:${l.classify.dispatchId}`,
            unit: e.unit,
            at: e.at,
            error: e.message,
            rungs: [],
            lane: l,
          });
        return;
      }
      const key = `${e.action}@${e.unit}`;
      s.failedEffects[key] = (s.failedEffects[key] ?? 0) + 1;
      // only the rules review's judge acts on the run itself, once every milestone is finished
      if (
        e.action === "judge" &&
        e.unit === RUN_UNIT &&
        s.milestones.length > 0 &&
        s.milestones.every((m) => isFinished(s, m))
      ) {
        if ((s.failedEffects[key] as number) >= MAX_TRIES) failRulesReview(s);
        return;
      }
      // a plan the check refused: its architect fixes it, PLAN_REVISIONS times, before the run parks
      const planning = e.action === "readPlan" && (s.phase === "planning" || s.phase === "approval");
      if (planning) s.revise = [e.message];
      // running: the architect of a milestone's fix round is re-dispatched from its delta, so the gap goes there
      else if (e.action === "readPlan")
        for (const m of s.milestones)
          if (m.delta.length > 0 && !m.delta.includes(e.message)) m.delta.push(e.message);
      const limit = planning ? PLAN_REVISIONS + 1 : MAX_TRIES;
      if ((s.failedEffects[key] as number) >= limit && e.action !== "report" && e.action !== "notify")
        s.stuck[e.unit] = {
          reason: "effect",
          question: `${e.action} on ${e.unit} failed: ${e.message}${e.action === "readPlan" ? `\n${SOURCE_PLAN_NOTE}` : ""}`,
        };
      return;
    }
    case "tick":
      for (const [k, until] of Object.entries(s.holds)) if (until <= e.at) delete s.holds[k];
      for (const [k, until] of Object.entries(s.waiting)) if (until <= e.at) delete s.waiting[k];
      for (const m of s.milestones) {
        if (m.mergeDue !== null && m.mergeDue <= e.at) m.mergeDue = isoPlus(e.at, MERGE_CHECK_MS);
        if (m.claimAfter !== null && m.claimAfter <= e.at) m.claimAfter = null;
      }
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
    case "stop.classified": {
      const l = Object.values(s.lanes).find((x) => x.classify?.dispatchId === e.dispatchId);
      if (!l?.classify) return;
      const { dispatchId: _id, reason: _reason, ...x } = l.classify;
      l.classify = null;
      delete s.decisionFails[`classify:${e.dispatchId}`];
      delete s.waiting[`classify:${e.dispatchId}`];
      if (e.failureClass === "harness") harnessRepair(s, l, x.why);
      else laneEnded(s, l, x, e.reason);
      return;
    }
    case "base.behind": {
      // the commit under verification is behind origin's base: merge the base first
      const m = milestoneOf(s, e.milestone);
      ok(`land@${e.milestone}`);
      ok(`machineCheck@${e.milestone}`);
      if (m && !isDone(m)) {
        m.status = "integrating";
        m.integrateFiles = [];
      }
      return;
    }
    case "integrate.done": {
      ok(`integrate@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m?.status === "integrating") mergedIn(m, e.commit);
      return;
    }
    case "integrate.conflict": {
      ok(`integrate@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (m?.status === "integrating") {
        m.integrateFiles = e.files;
        m.tries = {};
      }
      return;
    }
    case "daemon.started":
    case "lock.waiting":
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

import type { BlockedReason } from "./blocked.ts";
import { quotaOf } from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import type { JudgeKind } from "./judge.ts";
import type { ReplyStatus, RunStatus } from "./record.ts";
import type { Role } from "./roles.ts";
import type { NotifyMoment } from "./profile.ts";
import type { ClimbReason } from "./route.ts";
import {
  type Finding,
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
/** A lane parked this many times at the top rung stops asking the judge and waits for the owner. */
export const TOP_RUNG_JUDGES = 3;
/** A name refused as a duplicate this many times in a row parks its unit. */
export const DUPLICATE_LIMIT = 3;
/** A role that fails this many times without a limit parks its unit. */
export const MAX_TRIES = 2;

/** Spec 2.0 decision 5: a soft cap of max(3, 2 + ⌈lanes/3⌉) fix rounds. */
export const softCap = (lanes: number): number => Math.max(3, 2 + Math.ceil(lanes / 3));

/** A finding's identity across rounds: its file and its first words, without line numbers (t3herd `findingKey`). */
export const findingKey = (f: string): string =>
  f
    .replace(/^[\W\d]*(BLOCKER|BUG)\**\s*/i, "")
    .replace(/:\d+(-\d+)?/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/._ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");

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
}

export interface LaneState {
  id: string;
  milestone: string;
  role: Role;
  kind: string | null;
  after: string[];
  owns: string[];
  status: LaneStatus;
  /** the lane's current route (after any climb) */
  rung: string | null;
  /** the thread its CLI session is on, resumed by a check retry and a fix round; null starts fresh */
  thread: string | null;
  /** its last climb reached the top rung */
  top: boolean;
  /** failed or partial tries since the last ok end or climb */
  attempts: number;
  checkFails: number;
  /** the rung whose quota hit a limit: the next dispatch takes a stand-in */
  failoverFrom: string | null;
  lastReason: BlockedReason | null;
  /** how many times the lane stood at the top rung (the judge is asked each time, up to TOP_RUNG_JUDGES) */
  sameReason: number;
  notes: string[];
  /** the review round whose fix this lane was armed for (a survived finding climbs first) */
  fixedRound: number | null;
  /** a climb the lane waits for before it runs again */
  climbReason: ClimbReason | null;
  /** how many stops in a row named `lastReason` (a provider_error is retried once, a check_broken waits once) */
  stopRun: number;
  /** a provider_error that repeated: the next dispatch fails over although no limit was hit */
  failoverNow: boolean;
  /** the lane's pending climb is for a too_hard stop: at the top rung the owner is asked, not the judge */
  tooHard: boolean;
  /** what the judge is asked about the parked lane: an owner-level question, or a lane out of rungs */
  awaiting: "question" | "unexpected" | null;
  /** an unexplained stop waiting for its classification: nothing else happens to the lane until it is in */
  classify: (LaneEnd & { dispatchId: string }) | null;
  /** when the lane last climbed: a sibling "untried since" is judged against it */
  climbedAt: string | null;
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
  commit: string | null;
  verifierRuns: number;
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
  /** verifier ends in a row that said check_broken */
  checkBroken: number;
  /** a base run: the files the merge of the base left in conflict (none until it did); non-empty means committing resolves it */
  integrateFiles: string[];
  /** a base run: when to look again whether origin's base holds the landed commit */
  mergeDue: string | null;
  /** the branch the landed commit is on, for the owner's push question */
  branch: string | null;
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
}

/** A report and phone notice the owner is owed: set by the event, cleared by its `report.posted`. */
export interface OwedReport {
  kind: ReportKind;
  unit: string;
  text: string;
  moment: NotifyMoment;
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
  failedEffects: Record<string, number>;
  cancelling: boolean;
  wakeAt: string | null;
  /** an architect ended and the plan was not read since */
  planDirty: boolean;
  /** dispatch name → until: refused for now (paused, every quota held) */
  waiting: Record<string, string>;
  /** unit → what the owner must be asked: the machine parks it */
  stuck: Record<string, { reason: ParkReason; question: string }>;
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
    notes: [],
    milestones: [],
    lanes: {},
    dispatches: {},
    questions: {},
    holds: {},
    judges: {},
    failedEffects: {},
    cancelling: false,
    wakeAt: null,
    planDirty: false,
    waiting: {},
    stuck: {},
    owed: {},
  };
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

/** At most one in plan 30: the first milestone not landed, merged or parked whose `after` landed (merged, in a base run). Plan 35: several. */
export function activeMilestones(s: RunState): MilestoneState[] {
  const finished = (id: string) => {
    const m = milestoneOf(s, id);
    return m === undefined || isFinished(s, m);
  };
  const first = s.milestones.find((m) => !isDone(m) && m.status !== "parked" && m.after.every(finished));
  return first ? [first] : [];
}

const bare = (p: string) => p.replace(/\/+$/, "");

/** The lane owning `file` by its longest `Owns:` entry, or null (no file, or none owns it). */
export function ownerOfFile(file: string | null, lanes: { id: string; owns: string[] }[]): string | null {
  if (!file) return null;
  let best: { id: string; len: number } | null = null;
  for (const l of lanes)
    for (const o of l.owns) {
      const e = bare(o);
      if ((file === e || file.startsWith(`${e}/`)) && (best === null || e.length > best.len))
        best = { id: l.id, len: e.length };
    }
  return best?.id ?? null;
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

const hasJudge = (s: RunState, unit: string): boolean => Object.values(s.judges).some((j) => j.unit === unit);

const isoPlus = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

function recomputeWake(s: RunState): void {
  const merges = s.milestones.flatMap((m) => (m.status === "landed" && m.mergeDue ? [m.mergeDue] : []));
  const all = [...Object.values(s.holds), ...Object.values(s.waiting), ...merges].sort();
  s.wakeAt = all[0] ?? null;
}

function mergePlan(s: RunState, plan: MilestonePlan[]): void {
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
      commit: null,
      verifierRuns: 0,
      landRefusals: 0,
      awaiting: [],
      tries: {},
      delta: [],
      confirmed: false,
      notes: [],
      verifierNotes: [],
      checkBroken: 0,
      integrateFiles: [],
      mergeDue: null,
      branch: null,
    };
    m.title = mp.title;
    m.after = mp.after;
    m.delta = [];
    for (const lp of mp.lanes) {
      const l = s.lanes[lp.id];
      if (l) {
        l.role = lp.role;
        l.kind = lp.kind;
        l.after = lp.after;
        l.owns = lp.owns;
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
          attempts: 0,
          checkFails: 0,
          failoverFrom: null,
          lastReason: null,
          sameReason: 0,
          notes: [],
          fixedRound: null,
          climbReason: null,
          stopRun: 0,
          failoverNow: false,
          tooHard: false,
          awaiting: null,
          classify: null,
          climbedAt: null,
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
  l.status = "done";
  l.notes = [];
  l.checkFails = 0;
  l.attempts = 0;
  l.failoverFrom = null;
  l.climbReason = null;
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
  m.checkBroken = 0;
  if (n === 0) {
    m.open = [];
    m.status = "verifying";
    return;
  }
  const lanes = lanesOf(s, m.id);
  // no progress means not fewer than a round that had findings: a clean review before a verifier FAIL is no baseline
  const before = m.counts[r - 2] ?? 0;
  const stop = r >= softCap(lanes.length) || (r >= 2 && before > 0 && n >= before);
  if (stop) {
    m.open = found;
    if (found.some((f) => f.label === "BLOCKER")) {
      m.status = "review";
      s.stuck[m.id] = {
        reason: "blocker",
        question: `${m.id} still has a BLOCKER after ${r} review round(s):\n${found.map((f) => f.text).join("\n")}`,
      };
      return;
    }
    m.knownIssues = found.map((f) => f.text);
    m.open = [];
    m.status = "verifying";
    return;
  }
  const previous = new Set(m.keys[r - 2] ?? []);
  const unowned: Finding[] = [];
  const survived = new Set<string>();
  for (const f of found) {
    const owner = ownerOfFile(f.file, lanes);
    const lane = owner ? s.lanes[owner] : undefined;
    if (!lane) {
      unowned.push(f);
      continue;
    }
    lane.notes.push(f.text);
    lane.status = "pending";
    lane.attempts = 0;
    lane.checkFails = 0;
    lane.fixedRound = r;
    if (previous.has(findingKey(f.text))) survived.add(lane.id);
  }
  for (const id of survived) (s.lanes[id] as LaneState).climbReason = "same-defect";
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

/** A stop that names no reason (plan 30b Ruling 7): the machine asks Jev, and with Jev off acts as 1.5 did. */
function unexplained(e: Extract<RunEvent, { type: "dispatch.ended" }>): boolean {
  if (e.reason !== null) return false;
  if (e.status === "ok")
    return e.replyStatus === null || e.replyStatus === "blocked" || e.replyStatus === "refused";
  return (e.status === "failed" || e.status === "timeout") && e.environment === null;
}

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
      l.climbReason = "blocked";
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
      if (l.stopRun >= 2) {
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

/** One lane dispatch's end, once its stop has a reason (or none): what 1.5 did with it, or the reason's rule. */
function laneEnded(s: RunState, l: LaneState, x: LaneEnd, reason: BlockedReason | null): void {
  if (x.status === "limit") {
    l.status = "pending";
    l.failoverFrom = x.rung;
    l.thread = null;
    return;
  }
  if (reason !== null) return laneStopped(s, l, x, reason);
  l.lastReason = null;
  l.stopRun = 0;
  if (x.status === "ok" && (x.replyStatus === "blocked" || x.replyStatus === "refused")) {
    // no reason, Jev off or unsure: 1.5 climbed a stuck lane
    l.thread = x.thread ?? l.thread;
    l.status = "pending";
    l.climbReason = "blocked";
  } else if (x.status === "ok" && x.replyStatus !== "partial") {
    l.attempts = 0;
    l.thread = x.thread ?? l.thread;
    l.failoverFrom = null;
    l.failoverNow = false;
    if (l.kind === "research") laneDone(s, l);
    else l.status = "checking";
  } else {
    l.attempts += 1;
    l.thread = null;
    l.status = "pending";
    if (l.attempts >= MAX_TRIES) l.climbReason = "unchanged";
  }
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
  if (dv.role === "judge") return;
  const lane = dv.lane ? s.lanes[dv.lane] : undefined;
  if (lane) {
    const x: LaneEnd = {
      rung: dv.rung,
      status: e.status,
      replyStatus: e.replyStatus,
      thread: e.thread,
      why: e.why,
      foreign: e.foreign,
    };
    // a stop that names no reason waits for its classification: nothing else happens to the lane meanwhile
    if (e.status !== "limit" && unexplained(e)) {
      lane.classify = { dispatchId: e.dispatchId, ...x };
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
    failRole(s, e, undefined);
    return;
  }
  if (e.name === integrateName(m.id) && m.status === "integrating") {
    const refused = e.replyStatus === "blocked" || e.replyStatus === "refused";
    if (e.status === "ok" && !refused) m.status = "committing";
    else failRole(s, e, m);
    return;
  }
  if ((dv.role === "reviewer" || dv.role === "ui-reviewer") && m.status === "review") {
    if (e.status === "ok" && e.replyStatus !== "blocked" && e.replyStatus !== "refused") {
      m.open.push(...e.findings);
      if (e.replyStatus === "partial" && e.name === `reviewer-${m.id}`)
        m.awaiting = m.awaiting.map((n) => (n === e.name ? `reviewer-${m.id}-2` : n));
      else m.awaiting = m.awaiting.filter((n) => n !== e.name);
      if (m.awaiting.length === 0) completeRound(s, m);
    } else failRole(s, e, m);
    return;
  }
  if (dv.role === "verifier" && m.status === "verifying") {
    // a check that cannot run: one fresh verifier more, then the owner (a BLOCKED: environment verdict parks first)
    if (e.status === "ok" && e.reason === "check_broken" && e.verdict !== "blocked") {
      m.checkBroken += 1;
      if (m.checkBroken >= 2)
        s.stuck[m.id] = {
          reason: "check_broken",
          question: `${e.name} could not run the check twice: ${e.why || "no reason given"}`,
        };
    } else if (e.status === "ok" && e.verdict === "pass") {
      m.verifierRuns += 1;
      m.checkBroken = 0;
      // a PASS about another commit than the milestone's is no verdict on it: a fresh verifier checks the right one
      if (m.commit !== null && e.head !== null && m.commit.startsWith(e.head)) {
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
    } else if (e.status === "ok" && e.verdict === "fail") {
      m.verifierRuns += 1;
      m.open = e.findings.length
        ? e.findings.map((f) => ({ ...f, label: "BLOCKER" as const }))
        : [{ label: "BLOCKER", text: `FAIL: ${e.why || "the verifier failed the milestone"}`, file: null }];
      completeRound(s, m);
    } else if (e.status === "ok" && e.verdict === "blocked") {
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
  l.attempts = 0;
  l.checkFails = 0;
  l.failoverFrom = null;
  l.failoverNow = false;
  l.climbReason = null;
  l.tooHard = false;
  l.stopRun = 0;
  l.climbedAt = e.at;
  if (e.top) {
    l.status = "parked";
    l.sameReason += 1;
    if (tooHard)
      // a stronger model was the only fix, and there is none: the owner decides
      s.stuck[l.id] = {
        reason: "too_hard",
        question: `${l.id} is too hard for its top rung (${e.rung}); no stronger model is left`,
      };
    else {
      l.awaiting = "unexpected";
      if (l.sameReason >= TOP_RUNG_JUDGES)
        s.stuck[l.id] = {
          reason: "too_hard",
          question: `${l.id} is at the top rung and still does not get through; the judge was asked ${l.sameReason} times`,
        };
    }
  } else l.status = "pending";
  const m = milestoneOf(s, l.milestone);
  if (m?.status === "fixing") l.fixedRound = m.counts.length;
}

function onJudged(s: RunState, e: Extract<RunEvent, { type: "judge.decided" }>): void {
  delete s.judges[e.id];
  const d = e.decision;
  const lane = s.lanes[e.unit];
  const m = milestoneOf(s, e.unit);
  switch (d.verb) {
    case "route": {
      if (!m) return;
      const lanes = lanesOf(s, m.id);
      for (const r of d.routes) {
        const f = m.open[r.finding - 1];
        if (!f) continue;
        const target = lanes.find((l) => l.id === r.to);
        if (target) {
          target.notes.push(f.text);
          target.status = "pending";
          target.attempts = 0;
          target.fixedRound = m.counts.length;
        } else if (r.to === "architect") m.delta.push(f.text);
      }
      m.open = [];
      settle(s, m);
      return;
    }
    case "answer":
      if (lane) {
        lane.notes.push(`The judge answered: ${d.answer}`);
        lane.status = "pending";
        lane.awaiting = null;
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
      }
      return;
    case "climb":
      if (lane) {
        lane.status = "pending";
        lane.awaiting = null;
        lane.climbReason = "blocked";
      }
      return;
    case "skip":
      if (lane) {
        const lm = milestoneOf(s, lane.milestone);
        lm?.knownIssues.push(`${lane.id} skipped: ${d.why}`);
        laneDone(s, lane);
      }
  }
}

function onAnswered(s: RunState, e: Extract<RunEvent, { type: "question.answered" }>): void {
  const q = s.questions[e.unit];
  delete s.questions[e.unit];
  delete s.stuck[e.unit];
  for (const k of Object.keys(s.failedEffects))
    if (k.endsWith(`@${e.unit}`) || k === `ended:${e.unit}`) delete s.failedEffects[k];
  const lane = s.lanes[e.unit];
  if (lane) {
    lane.notes.push(`The owner answered: ${e.answer}`);
    lane.status = "pending";
    lane.attempts = 0;
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
    if (e.unit === RUN_UNIT) s.notes.push(`The owner answered: ${e.answer}`);
    return;
  }
  // the owner's word that a push question's milestone is merged: how a squash merge unblocks its dependants
  if (q?.reason === "push") {
    if (m.status === "landed") m.status = "merged";
    return;
  }
  m.notes.push(`The owner answered: ${e.answer}`);
  const from = m.parkedFrom ?? "waiting";
  m.parkedFrom = null;
  m.tries = {};
  m.checkBroken = 0;
  if (from === "routing") {
    m.status = "waiting";
    m.confirmed = true;
  } else if (q?.reason === "blocker") {
    m.knownIssues = m.open.map((f) => f.text);
    m.open = [];
    m.status = "verifying";
  } else m.status = from;
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
      return;
    case "plan.ready":
      mergePlan(s, e.milestones);
      if (s.phase === "planning") s.phase = "running";
      s.planDirty = false;
      ok(`readPlan@${RUN_UNIT}`);
      for (const m of s.milestones) settle(s, m);
      return;
    case "plan.approved":
      if (s.phase === "approval") s.phase = "running";
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
      ok(`dispatch@${e.unit}`);
      ok(`duplicate:${e.name}@${e.unit}`);
      if (e.role === "judge") {
        const id = e.name.replace(/^judge-/, "");
        s.judges[id] = { unit: e.unit, kind: e.judgeKind ?? "unexpected", tries: s.judges[id]?.tries ?? 0 };
      }
      const l = e.lane ? s.lanes[e.lane] : undefined;
      if (l && (l.status === "pending" || l.status === "checking")) {
        l.status = "running";
        l.climbReason = null;
      }
      return;
    }
    case "dispatch.refused": {
      const wait = (until: string) => {
        s.waiting[e.name] = until;
        recomputeWake(s);
      };
      if (e.code === "E_RUN_CANCELLED") return;
      if (e.code === "E_RUN_BUDGET")
        s.stuck[RUN_UNIT] = { reason: "budget", question: `The run budget is spent: ${e.message}` };
      else if (e.code === "E_ADMIT_PAUSED") wait(isoPlus(e.at, REFUSAL_WAIT_MS));
      else if (e.code === "E_ALL_HELD") {
        const l = s.lanes[e.unit];
        const heldUntil = Object.values(s.holds)
          .filter((u) => u > e.at)
          .sort()[0];
        // a repeated provider_error holds no quota: with no stand-in free either, waiting would never end
        if (l?.failoverNow && heldUntil === undefined) {
          l.status = "parked";
          s.stuck[l.id] = {
            reason: "provider_error",
            question: stopQuestion(l, "provider_error", "no stand-in rung is free"),
          };
        } else wait(heldUntil ?? isoPlus(e.at, REFUSAL_WAIT_MS));
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
      // a check that fails only in a sibling's files has nothing to say about this lane
      if (e.exit === 0 || e.foreign.length > 0) laneDone(s, l);
      else {
        l.checkFails += 1;
        l.notes = [
          ...l.notes.filter((n) => !n.startsWith("The fast check failed")),
          `The fast check failed (exit ${e.exit ?? "timeout"}); its last lines:\n${e.tail}`,
        ];
        l.status = "pending";
        if (l.checkFails >= MAX_TRIES) l.climbReason = "check-failed-twice";
      }
      return;
    }
    case "commit.made": {
      ok(`commit@${e.milestone}`);
      const m = milestoneOf(s, e.milestone);
      if (!m) return;
      // the commit that finishes a merge of the base: reviews stay (by time), a fresh verifier gates the merge
      if (m.integrateFiles.length > 0) return mergedIn(m, e.commit);
      m.status = "review";
      m.round = e.round;
      m.commit = e.commit;
      m.open = [];
      m.tries = {};
      m.awaiting = reviewersOf(s, m);
      if (m.awaiting.length === 0) completeRound(s, m);
      return;
    }
    case "commit.failed": {
      ok(`commit@${e.milestone}`);
      s.stuck[e.milestone] = {
        reason: "commit",
        question: `Committing ${e.milestone} failed (round ${e.round}):\n${e.tail}`,
      };
      return;
    }
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
      j.tries += 1;
      if (j.tries >= MAX_TRIES) {
        delete s.judges[e.id];
        s.stuck[e.unit] = { reason: "judge", question: `The judge could not decide ${e.unit}: ${e.why}` };
      }
      return;
    }
    case "question.parked": {
      s.questions[e.unit] = { unit: e.unit, question: e.question, reason: e.reason, at: e.at };
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
      if (l) l.status = "parked";
      else if (m && e.reason !== "push" && m.status !== "parked") {
        m.parkedFrom = m.status;
        m.status = "parked";
      }
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
      // the first refusal is most often a verifier that skipped gate_run: a fresh one with the message; the second parks
      if (m?.status === "landing" && m.landRefusals === 1) {
        m.status = "verifying";
        m.tries = {};
        m.verifierNotes = [
          `A landing of this milestone was refused (${e.code}): ${e.message}`,
          `Fix: ${e.fix}`,
        ];
        return;
      }
      s.stuck[e.milestone] = {
        reason: "land",
        question: `Landing ${e.milestone} was refused (${e.code}): ${e.message}\nFix: ${e.fix}`,
      };
      return;
    }
    case "milestone.merged": {
      const m = milestoneOf(s, e.milestone);
      if (m) {
        m.status = "merged";
        m.mergeDue = null;
      }
      if (s.questions[e.milestone]?.reason === "push") delete s.questions[e.milestone];
      recomputeWake(s);
      return;
    }
    case "cancel.requested":
      s.cancelling = true;
      return;
    case "effect.failed": {
      if (e.action === "readPlan") s.planDirty = false;
      if (e.action === "classify") {
        // a classification that cannot be made is none: the lane goes on as in 1.5
        const l = s.lanes[e.unit];
        if (l?.classify) {
          const { dispatchId: _id, ...x } = l.classify;
          l.classify = null;
          laneEnded(s, l, x, null);
        }
        return;
      }
      const key = `${e.action}@${e.unit}`;
      s.failedEffects[key] = (s.failedEffects[key] ?? 0) + 1;
      if ((s.failedEffects[key] as number) >= MAX_TRIES && e.action !== "report" && e.action !== "notify")
        s.stuck[e.unit] = { reason: "effect", question: `${e.action} on ${e.unit} failed: ${e.message}` };
      return;
    }
    case "tick":
      for (const [k, until] of Object.entries(s.holds)) if (until <= e.at) delete s.holds[k];
      for (const [k, until] of Object.entries(s.waiting)) if (until <= e.at) delete s.waiting[k];
      for (const m of s.milestones)
        if (m.mergeDue !== null && m.mergeDue <= e.at) m.mergeDue = isoPlus(e.at, MERGE_CHECK_MS);
      recomputeWake(s);
      return;
    case "run.ended":
      s.phase = "ended";
      s.outcome = e.outcome;
      return;
    case "report.posted":
      delete s.owed[`${e.kind}:${e.unit}`];
      return;
    case "stop.classified": {
      const l = Object.values(s.lanes).find((x) => x.classify?.dispatchId === e.dispatchId);
      if (!l?.classify) return;
      const { dispatchId: _id, ...x } = l.classify;
      l.classify = null;
      laneEnded(s, l, x, e.reason);
      return;
    }
    case "base.behind": {
      // the commit under verification is behind origin's base: merge the base first
      const m = milestoneOf(s, e.milestone);
      ok(`land@${e.milestone}`);
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

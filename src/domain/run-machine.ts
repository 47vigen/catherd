import { type JudgeInput, type JudgeKind, judgeName } from "./judge.ts";
import { overlaps } from "./lane.ts";
import { quotaOf } from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import type { NotifyMoment } from "./profile.ts";
import type { Role } from "./roles.ts";
import type { ClimbReason } from "./route.ts";
import { ACTION_TYPES, type ParkReason, type ReportKind, RUN_UNIT, type RunEvent } from "./run-events.ts";
import {
  activeMilestones,
  integrateName,
  isFinished,
  type LaneState,
  lanesOf,
  limitedRung,
  liveDispatches,
  MAX_TRIES,
  MERGE_CHECK_MS,
  type MilestoneState,
  type RunState,
} from "./run-state.ts";

export type BriefKind = "dossier" | "architect" | "lane" | "fix" | "review" | "recheck" | "verify" | "judge";

export type Action =
  | {
      type: "dispatch";
      unit: string;
      name: string;
      role: Role;
      lane: string | null;
      rung: string | null;
      thread: string | null;
      failoverFrom: string | null;
      brief: BriefKind;
      notes: string[];
    }
  | { type: "watch"; dispatchId: string }
  | { type: "readPlan" }
  | { type: "route"; milestone: string; confirmed: boolean }
  | { type: "fastCheck"; lane: string }
  | { type: "commit"; milestone: string; round: number }
  | { type: "climb"; lane: string; reason: ClimbReason }
  | { type: "judge"; input: JudgeInput }
  | { type: "classify"; dispatchId: string }
  | { type: "park"; unit: string; question: string; reason: ParkReason }
  | { type: "land"; milestone: string; knownIssues: string[] }
  | { type: "checkMerged"; milestone: string }
  | { type: "integrate"; milestone: string }
  | { type: "cancel"; dispatchIds: string[] }
  | { type: "report"; kind: ReportKind; unit: string; text: string }
  | { type: "notify"; unit: string; moment: NotifyMoment }
  | { type: "finish"; outcome: "done" | "cancelled" | "failed" };

// every action type is one `effect.failed` can name, and the other way round
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const ACTIONS_MATCH_EVENTS: Same<Action["type"], (typeof ACTION_TYPES)[number]> = true;

/** The key an issued action is remembered by until an event confirms it; the daemon never issues one twice. */
export function actionKey(a: Action): string {
  switch (a.type) {
    case "dispatch":
      return `dispatch:${a.name}`;
    case "watch":
    case "classify":
      return `${a.type}:${a.dispatchId}`;
    case "readPlan":
      return "readPlan";
    case "route":
    case "land":
    case "checkMerged":
    case "integrate":
      return `${a.type}:${a.milestone}`;
    case "fastCheck":
    case "climb":
      return `${a.type}:${a.lane}`;
    case "commit":
      return `commit:${a.milestone}:${a.round}`;
    case "judge":
      return `judge:${a.input.unit}:${a.input.kind}`;
    case "park":
      return `park:${a.unit}`;
    case "cancel":
      return "cancel:run";
    case "report":
      return `report:${a.kind}:${a.unit}`;
    case "notify":
      return `notify:${a.unit}:${a.moment}`;
    case "finish":
      return "finish:run";
  }
}

/** The unit an action works on: what `effect.failed` names it by. */
export function unitOf(a: Action, s?: RunState): string {
  switch (a.type) {
    case "dispatch":
    case "park":
    case "report":
    case "notify":
      return a.unit;
    case "watch":
    case "classify":
      return s?.dispatches[a.dispatchId]?.unit ?? RUN_UNIT;
    case "route":
    case "land":
    case "checkMerged":
    case "integrate":
    case "commit":
      return a.milestone;
    case "fastCheck":
    case "climb":
      return a.lane;
    case "judge":
      return a.input.unit;
    case "readPlan":
    case "cancel":
    case "finish":
      return RUN_UNIT;
  }
}

/** What `effect.failed` carries to name an action: its type and unit. The daemon frees the matching key. */
export const failKey = (a: Action, s?: RunState): string => `${a.type}@${unitOf(a, s)}`;

/** The keys an event settles: what the daemon forgets, so a still-ready action may be issued again. */
export function confirms(e: RunEvent): string[] {
  switch (e.type) {
    case "dispatch.started":
      return [
        `dispatch:${e.name}`,
        ...(e.role === "judge" && e.judgeKind ? [`judge:${e.unit}:${e.judgeKind}`] : []),
      ];
    case "dispatch.refused":
      return [`dispatch:${e.name}`];
    case "dispatch.ended":
      return [`watch:${e.dispatchId}`, `classify:${e.dispatchId}`, "cancel:run"];
    case "stop.classified":
      return [`classify:${e.dispatchId}`];
    case "plan.ready":
      return ["readPlan"];
    case "preflight.done":
      return [`route:${e.milestone}`];
    case "check.ran":
      return [`fastCheck:${e.lane}`];
    case "commit.made":
    case "commit.failed":
      return [`commit:${e.milestone}:${e.round}`];
    case "lane.climbed":
      return [`climb:${e.lane}`];
    case "judge.decided":
    case "judge.failed":
      return (["triage", "question", "unexpected"] as const).map((k) => `judge:${e.unit}:${k}`);
    case "question.parked":
      return [`park:${e.unit}`];
    case "milestone.landed":
    case "land.refused":
    case "base.behind":
      return [`land:${e.milestone}`];
    case "integrate.done":
    case "integrate.conflict":
      return [`integrate:${e.milestone}`];
    case "milestone.merged":
      return [`checkMerged:${e.milestone}`];
    case "run.ended":
      return ["finish:run", "cancel:run"];
    case "report.posted":
      return [`report:${e.kind}:${e.unit}`];
    case "effect.failed":
      return [`${e.action}@${e.unit}`];
    default:
      return [];
  }
}

const held = (s: RunState, rung: string | null): boolean => {
  const r = rung ? tryParseRung(rung) : null;
  const until = r ? s.holds[quotaOf(r)] : undefined;
  return until !== undefined && until > s.at;
};
const waiting = (s: RunState, name: string): boolean => (s.waiting[name] ?? "") > s.at;
const hasLive = (s: RunState, name: string): boolean => liveDispatches(s).some((d) => d.name === name);
const judgeOpen = (s: RunState, unit: string): boolean =>
  Object.values(s.judges).some((j) => j.unit === unit);

/** The brief and the dispatch of a lane-less role: its rung is routed by the effect, a limit gives a stand-in. */
function roleDispatch(
  s: RunState,
  o: { unit: string; name: string; role: Role; brief: BriefKind; notes?: string[]; thread?: string | null },
): Action[] {
  if (hasLive(s, o.name) || waiting(s, o.name)) return [];
  const limited = limitedRung(s, o.name);
  return [
    {
      type: "dispatch",
      unit: o.unit,
      name: o.name,
      role: o.role,
      lane: null,
      rung: null,
      thread: limited ? null : (o.thread ?? null),
      failoverFrom: limited && held(s, limited) ? limited : null,
      brief: o.brief,
      notes: o.notes ?? [],
    },
  ];
}

const laneName = (l: LaneState): string => `${l.role}-${l.id}`;

/** The input of one judge call, rebuilt from the state: the daemon asks the same question again from it. */
export function judgeInputFor(s: RunState, id: string, kind: JudgeKind, unit: string): JudgeInput {
  const lane = s.lanes[unit];
  const m = lane
    ? s.milestones.find((x) => x.id === lane.milestone)
    : s.milestones.find((x) => x.id === unit);
  const lanes = (m ? lanesOf(s, m.id) : Object.values(s.lanes)).map((l) => ({ id: l.id, owns: l.owns }));
  if (kind === "triage")
    return {
      id,
      kind,
      unit,
      context: `Milestone ${unit}, review round ${m?.counts.length ?? 0}: findings no lane owns. Send each to the lane that should fix it, to the architect when the plan itself is wrong, or dismiss it.`,
      findings: (m?.open ?? []).map((f) => f.text),
      lanes,
    };
  const last = Object.values(s.dispatches)
    .filter((d) => d.lane === unit)
    .at(-1);
  if (kind === "question")
    return {
      id,
      kind,
      unit,
      context: last
        ? `Lane ${unit}: ${last.name} stopped with STATUS ${last.ended?.replyStatus ?? "none"}.\nreply: roles/${last.name}/${last.dispatchId}/reply.md`
        : `Lane ${unit} stopped and asked for a decision.`,
      findings: [],
      lanes,
    };
  return {
    id,
    kind,
    unit,
    context:
      `Lane ${unit} is at the top rung of its ladder (${lane?.rung ?? "unknown"}) and did not get through; it has stood there ${lane?.sameReason ?? 0} time(s). Decide: retry once more, climb, skip it as a known issue, or park it for the owner.\n${lane?.notes.join("\n") ?? ""}`.trimEnd(),
    findings: [],
    lanes,
  };
}

/**
 * A lane whose check was broken by something outside its task waits while a sibling of its milestone is still
 * working or has not tried yet: the sibling may be what breaks (or fixes) the check. A sibling that waits on this
 * lane, or that tried and stopped, never holds it.
 */
function waitsForSibling(s: RunState, l: LaneState): boolean {
  if (l.lastReason !== "check_broken" || l.stopRun !== 1) return false;
  return lanesOf(s, l.milestone).some((o) => {
    if (o.id === l.id || o.after.includes(l.id)) return false;
    if (o.status === "running") return true;
    if (o.status !== "pending") return false;
    const tried = Object.values(s.dispatches).filter((d) => d.lane === o.id);
    const latest = tried.at(-1);
    return latest === undefined || (o.climbedAt !== null && latest.startedAt < o.climbedAt);
  });
}

function laneActions(s: RunState, m: MilestoneState): Action[] {
  const out: Action[] = [];
  const lanes = lanesOf(s, m.id);
  const live = liveDispatches(s);
  for (const l of lanes) {
    if (s.stuck[l.id] || s.questions[l.id]) continue;
    if (l.classify) {
      out.push({ type: "classify", dispatchId: l.classify.dispatchId });
      continue;
    }
    if (l.status === "checking" && !hasLive(s, laneName(l))) out.push({ type: "fastCheck", lane: l.id });
    else if (l.status === "parked") {
      if (!judgeOpen(s, l.id))
        out.push(...onLaneStopped(s, l, l.awaiting ?? (l.top ? "unexpected" : "question")));
    } else if (l.status === "pending") {
      const name = laneName(l);
      if (hasLive(s, name) || waiting(s, name)) continue;
      if (waitsForSibling(s, l)) continue;
      if (!l.after.every((a) => s.lanes[a] === undefined || s.lanes[a]?.status === "done")) continue;
      // lanes that own the same paths wait for each other, as admission would refuse them anyway
      const clash = live.some((d) => {
        const other = d.lane && d.lane !== l.id ? s.lanes[d.lane] : undefined;
        return other !== undefined && overlaps(l.owns, other.owns).length > 0;
      });
      if (clash) continue;
      if (l.climbReason) {
        out.push({ type: "climb", lane: l.id, reason: l.climbReason });
        continue;
      }
      // a limit fails over while its quota is held; a provider_error that repeated does so with no hold
      const failoverFrom = l.failoverNow
        ? (l.failoverFrom ?? l.rung)
        : held(s, l.rung)
          ? l.rung
          : l.failoverFrom && held(s, l.failoverFrom)
            ? l.failoverFrom
            : null;
      out.push({
        type: "dispatch",
        unit: l.id,
        name,
        role: l.role,
        lane: l.id,
        rung: l.rung,
        thread: failoverFrom ? null : l.thread,
        failoverFrom,
        brief: l.notes.length ? "fix" : "lane",
        notes: l.notes,
      });
    }
  }
  return out;
}

/**
 * A lane that asked a question (needs_user: the judge answers it from the plan and the code, or asks the owner) or
 * ran out of rungs: the judge decides. The other stop reasons never reach it; the state maps them to a transition.
 */
export function onLaneStopped(s: RunState, lane: LaneState, kind: "question" | "unexpected"): Action[] {
  return [{ type: "judge", input: judgeInputFor(s, String(s.seq), kind, lane.id) }];
}

/** A limit: the unit went back to pending with its rung to fail over from (reduce did it); the dispatch takes the stand-in. */
export function onLimit(_s: RunState, _e: RunEvent): Action[] {
  return [];
}

/**
 * A verifier's verdict is in the milestone's status (reduce did it): landing only for a PASS that names the
 * milestone's commit, a fresh verifier for a PASS that names another or a check that could not run, a fix round
 * for a FAIL, a park for BLOCKED: environment. The dispatch of a fresh verifier is milestoneActions'.
 */
export function onVerifier(_s: RunState, _m: MilestoneState, _e: RunEvent): Action[] {
  return [];
}

/** A judge call whose answer was unreadable is asked again, under the same id, until the state gives up on it. */
function judgeRetries(s: RunState): Action[] {
  return Object.entries(s.judges)
    .filter(([id]) => !hasLive(s, judgeName(id)))
    .map(([id, j]) => ({ type: "judge", input: judgeInputFor(s, id, j.kind, j.unit) }));
}

function fixActions(s: RunState, m: MilestoneState): Action[] {
  const out: Action[] = [];
  if (s.stuck[m.id]) return out;
  if (m.open.length > 0 && !judgeOpen(s, m.id))
    out.push({ type: "judge", input: judgeInputFor(s, String(s.seq), "triage", m.id) });
  if (m.delta.length > 0 && !s.planDirty) {
    const r = m.counts.length;
    if (!Object.values(s.dispatches).some((d) => !d.ended && d.name.startsWith(`architect-${m.id}-`)))
      out.push(
        ...roleDispatch(s, {
          unit: m.id,
          name: `architect-${m.id}-${r}`,
          role: "architect",
          brief: "architect",
          notes: m.delta,
        }),
      );
  }
  return out;
}

function reviewActions(s: RunState, m: MilestoneState): Action[] {
  const out: Action[] = [];
  for (const name of m.awaiting) {
    if ((m.tries[name] ?? 0) >= MAX_TRIES) continue;
    const second = name === `reviewer-${m.id}-2`;
    const ui = name === `ui-reviewer-${m.id}`;
    const prior = Object.values(s.dispatches)
      .filter((d) => d.name === name && d.ended?.status === "ok")
      .at(-1);
    out.push(
      ...roleDispatch(s, {
        unit: m.id,
        name,
        role: ui ? "ui-reviewer" : "reviewer",
        brief: second || (m.round > 0 && !ui) ? "recheck" : "review",
        thread: second ? null : (prior?.thread ?? null),
      }),
    );
  }
  return out;
}

function milestoneActions(s: RunState, m: MilestoneState): Action[] {
  if (s.stuck[m.id] || s.questions[m.id]) return [];
  switch (m.status) {
    case "waiting":
      return [{ type: "route", milestone: m.id, confirmed: m.confirmed }];
    case "routing":
      // preflight did not end (a crash, a lost effect): route again; the key keeps one in flight
      return [{ type: "route", milestone: m.id, confirmed: m.confirmed }];
    case "lanes":
      return laneActions(s, m);
    case "fixing":
      return [...laneActions(s, m), ...fixActions(s, m)];
    case "committing":
      return [{ type: "commit", milestone: m.id, round: m.counts.length }];
    case "review":
      return reviewActions(s, m);
    case "verifying":
      return (m.tries[`verifier-${m.id}`] ?? 0) >= MAX_TRIES
        ? []
        : roleDispatch(s, {
            unit: m.id,
            name: `verifier-${m.id}`,
            role: "verifier",
            brief: "verify",
            notes: m.verifierNotes,
          });
    case "landing":
      return [{ type: "land", milestone: m.id, knownIssues: m.knownIssues }];
    case "integrating":
      // the merge first; its conflicts, once known, go to a worker, whose clean end is a commit (reduce)
      if (m.integrateFiles.length === 0) return [{ type: "integrate", milestone: m.id }];
      return roleDispatch(s, {
        unit: m.id,
        name: integrateName(m.id),
        role: "worker",
        brief: "fix",
        notes: m.integrateFiles,
      });
    default:
      return [];
  }
}

function planningActions(s: RunState): Action[] {
  if (s.planDirty) return [{ type: "readPlan" }];
  const planned = s.plan.length > 0 || s.aLines.some((l) => /^\s*plan:/i.test(l));
  const dossierOk = Object.values(s.dispatches).some(
    (d) => d.name === "researcher-dossier" && d.ended?.status === "ok" && d.ended.replyStatus !== "blocked",
  );
  if (planned || dossierOk)
    return roleDispatch(s, { unit: RUN_UNIT, name: "architect", role: "architect", brief: "architect" });
  return roleDispatch(s, {
    unit: RUN_UNIT,
    name: "researcher-dossier",
    role: "researcher",
    brief: "dossier",
  });
}

/** A landed milestone of a base run is the owner's to push and merge: catherd never pushes (spec 2.0, decision 21). */
function pushQuestion(s: RunState, m: MilestoneState): string {
  const base = s.base ?? "the base";
  return `${m.id} landed on ${m.branch ?? "the run's branch"} at ${(m.commit ?? "").slice(0, 12)}: push it and open and merge its MR (precheck: git fetch -q origin ${base} && git merge-base --is-ancestor origin/${base} HEAD); answer once it is merged`;
}

function advance(s: RunState): Action[] {
  if (s.phase === "ended") return [];
  const live = liveDispatches(s);
  if (s.cancelling)
    return live.length > 0
      ? [{ type: "cancel", dispatchIds: live.map((d) => d.dispatchId) }]
      : [{ type: "finish", outcome: "cancelled" }];
  const parks: Action[] = Object.entries(s.stuck)
    .filter(([unit]) => !s.questions[unit])
    .map(([unit, q]) => ({ type: "park", unit, question: q.question, reason: q.reason }));
  if (s.base !== null)
    for (const m of s.milestones)
      if (m.status === "landed" && !s.questions[m.id] && !s.stuck[m.id])
        parks.push({ type: "park", unit: m.id, question: pushQuestion(s, m), reason: "push" });
  if (s.stuck[RUN_UNIT] || s.questions[RUN_UNIT]) return parks;
  if (s.phase === "planning") return [...parks, ...planningActions(s)];
  if (s.phase === "approval") return parks;
  if (s.planDirty) return [...parks, { type: "readPlan" }];
  if (s.milestones.length > 0 && s.milestones.every((m) => isFinished(s, m)))
    return [...parks, { type: "finish", outcome: "done" }];
  return [...parks, ...judgeRetries(s), ...activeMilestones(s).flatMap((m) => milestoneActions(s, m))];
}

function react(s: RunState, e: RunEvent): Action[] {
  switch (e.type) {
    case "daemon.started":
      return liveDispatches(s).map((d) => ({ type: "watch", dispatchId: d.dispatchId }));
    case "question.parked":
      return [
        {
          type: "report",
          kind: "parked",
          unit: e.unit,
          text: `${e.unit} is parked (${e.reason}): ${e.question}`,
        },
        { type: "notify", unit: e.unit, moment: "blocked" },
      ];
    case "milestone.landed":
      return [
        {
          type: "report",
          kind: "landed",
          unit: e.milestone,
          text: `${e.milestone} landed at ${e.commit.slice(0, 7)}${
            e.knownIssues.length ? `, with ${e.knownIssues.length} known issue(s)` : ""
          }: ${s.milestones.find((m) => m.id === e.milestone)?.title ?? ""}`.trimEnd(),
        },
        { type: "notify", unit: e.milestone, moment: "milestone" },
        ...(s.base !== null ? [{ type: "checkMerged" as const, milestone: e.milestone }] : []),
      ];
    case "tick":
      // a landed milestone whose merge check this tick re-armed (reduce set its next look MERGE_CHECK_MS ahead)
      return s.milestones
        .filter(
          (m) =>
            m.status === "landed" && m.mergeDue === new Date(Date.parse(e.at) + MERGE_CHECK_MS).toISOString(),
        )
        .map((m) => ({ type: "checkMerged" as const, milestone: m.id }));
    case "run.ended":
      return [
        {
          type: "report",
          kind: e.outcome === "done" ? "finished" : e.outcome,
          unit: RUN_UNIT,
          text: `The run ${e.outcome === "done" ? "finished" : e.outcome}${e.reportPath ? `: ${e.reportPath}` : ""}`,
        },
        { type: "notify", unit: RUN_UNIT, moment: "finish" },
      ];
    default:
      return [];
  }
}

/** The reports and notices still owed: a park's and a landing's, until their `report.posted`. */
function owedActions(s: RunState): Action[] {
  return Object.values(s.owed)
    .filter((o) => (s.failedEffects[`report@${o.unit}`] ?? 0) < MAX_TRIES)
    .flatMap((o): Action[] => [
      { type: "report", kind: o.kind, unit: o.unit, text: o.text },
      { type: "notify", unit: o.unit, moment: o.moment },
    ]);
}

const sameLine = (s: RunState, a: Action): boolean => a.type === "dispatch" && hasLive(s, a.name);

/**
 * The machine: the reactions to `e`, then every step the state is ready for (`state` is the fold including `e`).
 * Level-triggered, so the daemon drops what it issued already (`actionKey`) until an event confirms it.
 */
export function next(state: RunState, e: RunEvent): Action[] {
  const seen = new Set<string>();
  return [...react(state, e), ...owedActions(state), ...advance(state)].filter((a) => {
    const key = actionKey(a);
    if (seen.has(key) || sameLine(state, a)) return false;
    seen.add(key);
    return true;
  });
}

import { type JudgeInput, type JudgeKind, judgeName, type RuleChange } from "./judge.ts";
import { overlaps } from "./lane.ts";
import { approvalQuestion } from "./plan-doc.ts";
import { quotaOf } from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import type { NotifyMoment } from "./profile.ts";
import type { Role } from "./roles.ts";
import type { ClimbReason } from "./route.ts";
import { ACTION_TYPES, type ParkReason, type ReportKind, RUN_UNIT, type RunEvent } from "./run-events.ts";
import {
  activeMilestones,
  dependsOn,
  integrateName,
  isFinished,
  type LaneState,
  lanesOf,
  limitedRung,
  liveDispatches,
  MAX_TRIES,
  MERGE_CHECK_MS,
  hasPlanInput,
  type MilestoneState,
  milestoneOf,
  remindDue,
  type RunState,
} from "./run-state.ts";

export type BriefKind = "dossier" | "architect" | "lane" | "fix" | "review" | "recheck" | "verify" | "judge";

export type RemindAction = { type: "remind"; unit: string; n: number };

export type Action =
  | RemindAction
  | {
      type: "dispatch";
      unit: string;
      name: string;
      role: Role;
      lane: string | null;
      rung: string | null;
      thread: string | null;
      failoverFrom: string | null;
      /** a mechanical fix: the cheapest capable rung runs it first, on a fresh thread */
      cheap?: true;
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
  | { type: "machineCheck"; milestone: string; commit: string }
  | { type: "land"; milestone: string; knownIssues: string[] }
  | { type: "checkMerged"; milestone: string }
  | { type: "integrate"; milestone: string }
  | { type: "claimTree"; milestone: string }
  | { type: "pushBranch"; milestone: string }
  | { type: "cancel"; dispatchIds: string[] }
  | { type: "report"; kind: ReportKind; unit: string; text: string }
  | { type: "notify"; unit: string; moment: NotifyMoment }
  | { type: "finish"; outcome: "done" | "cancelled" | "failed"; proposals?: RuleChange[] };

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
    case "machineCheck":
    case "land":
    case "checkMerged":
    case "integrate":
    case "claimTree":
    case "pushBranch":
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
    case "remind":
      return `remind:${a.unit}:${a.n}`;
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
    case "remind":
      return a.unit;
    case "watch":
    case "classify":
      return s?.dispatches[a.dispatchId]?.unit ?? RUN_UNIT;
    case "route":
    case "machineCheck":
    case "land":
    case "checkMerged":
    case "integrate":
    case "claimTree":
    case "pushBranch":
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
      return (["triage", "question", "unexpected", "rules"] as const).map((k) => `judge:${e.unit}:${k}`);
    case "question.parked":
      return [`park:${e.unit}`];
    case "question.reminded":
      return [`remind:${e.unit}:${e.n}`];
    case "milestone.checked":
      return [`machineCheck:${e.milestone}`];
    case "milestone.landed":
    case "land.refused":
      return [`land:${e.milestone}`];
    case "base.behind":
      return [`land:${e.milestone}`, `machineCheck:${e.milestone}`];
    case "integrate.done":
    case "integrate.conflict":
      return [`integrate:${e.milestone}`];
    case "milestone.merged":
      return [`checkMerged:${e.milestone}`];
    case "tree.ready":
    case "tree.deferred":
      return [`claimTree:${e.milestone}`];
    case "branch.pushed":
      return [`pushBranch:${e.milestone}`];
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
  if (kind === "rules")
    return {
      id,
      kind,
      unit,
      context: s.milestones
        .map(
          (m) =>
            `${m.id} ${m.title}: ${m.counts.length} review round(s), ${m.knownIssues.length} known issue(s)`,
        )
        .join("\n"),
      findings: [],
      lanes: [],
    };
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
    if (o.id === l.id || dependsOn(s, o, l.id)) return false;
    if (o.status === "running") return true;
    if (o.status !== "pending") return false;
    const tried = Object.values(s.dispatches).filter((d) => d.lane === o.id);
    const latest = tried.at(-1);
    return latest === undefined || (o.climbedAt !== null && latest.startedAt < o.climbedAt);
  });
}

/**
 * Whether every lane `l` must follow has finished. In a base run (plan 35) a lane of the same milestone must be done,
 * and another milestone's lane, or a whole milestone, must be merged: the milestones work side by side.
 */
function afterReady(s: RunState, l: LaneState): boolean {
  return l.after.every((a) => {
    if (s.base !== null) {
      const dep = a.split(".")[0] as string;
      if (dep !== l.milestone) {
        const m = milestoneOf(s, dep);
        return m === undefined || isFinished(s, m);
      }
    }
    return s.lanes[a] === undefined || s.lanes[a]?.status === "done";
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
    if (l.status === "checking" && !hasLive(s, laneName(l))) {
      // a check broken by a sibling's files reruns once that sibling is done
      if (l.waitOn.every((id) => s.lanes[id] === undefined || s.lanes[id]?.status === "done"))
        out.push({ type: "fastCheck", lane: l.id });
    } else if (l.status === "parked") {
      if (!judgeOpen(s, l.id))
        out.push(...onLaneStopped(s, l, l.awaiting ?? (l.top ? "unexpected" : "question")));
    } else if (l.status === "pending") {
      const name = laneName(l);
      if (hasLive(s, name) || waiting(s, name)) continue;
      if (waitsForSibling(s, l)) continue;
      if (!afterReady(s, l)) continue;
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
        thread: failoverFrom || l.cheapFirst ? null : l.thread,
        failoverFrom,
        ...(l.cheapFirst ? { cheap: true as const } : {}),
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
      // a base run's milestone first needs its worktree, claimed one at a time (a memory deferral waits for its time)
      if (s.base !== null && m.tree === null)
        return m.claimAfter === null || m.claimAfter <= s.at ? [{ type: "claimTree", milestone: m.id }] : [];
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
      // the daemon's check of the commit comes first; the verifier is owed only for what it does not settle
      if (m.commit !== null && m.checkedOn !== m.commit)
        return [{ type: "machineCheck", milestone: m.id, commit: m.commit }];
      if (m.commit !== null && m.commit === m.verifierFailedOn)
        return [
          {
            type: "park",
            unit: m.id,
            reason: "verifier",
            question: `${m.id}'s verifier already failed commit ${m.commit}; the fix round left it unchanged. Make a new commit or answer when the check is ready to retry.`,
          },
        ];
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

/** The architect of the run's plan, again: on the thread of its last dispatch when there is something to change. */
function architectAgain(s: RunState): Action[] {
  const thread = Object.values(s.dispatches)
    .filter((d) => d.name === "architect")
    .at(-1)?.thread;
  return roleDispatch(s, {
    unit: RUN_UNIT,
    name: "architect",
    role: "architect",
    brief: "architect",
    notes: s.revise,
    thread: s.revise.length > 0 ? (thread ?? null) : null,
  });
}

function planningActions(s: RunState): Action[] {
  if (s.planDirty) return [{ type: "readPlan" }];
  const planned = hasPlanInput(s);
  const dossierOk = Object.values(s.dispatches).some(
    (d) => d.name === "researcher-dossier" && d.ended?.status === "ok" && d.ended.replyStatus !== "blocked",
  );
  if (planned || dossierOk) return architectAgain(s);
  return roleDispatch(s, {
    unit: RUN_UNIT,
    name: "researcher-dossier",
    role: "researcher",
    brief: "dossier",
  });
}

/**
 * The owner has not approved the plan yet: read what the architect wrote, let it revise on a change request, and
 * otherwise ask. No lane and no route runs meanwhile.
 */
function approvalActions(s: RunState): Action[] {
  if (s.planDirty) return [{ type: "readPlan" }];
  if (hasLive(s, "architect")) return [];
  if (s.revise.length > 0) return architectAgain(s);
  return [{ type: "park", unit: RUN_UNIT, question: approvalQuestion(s.run), reason: "approval" }];
}

/** The check the owner runs right before merging an MR: the branch must contain origin's base. */
const precheck = (s: RunState, m: MilestoneState): string => {
  const base = s.base ?? "the base";
  const tree = m.tree ?? ".";
  return `git -C ${tree} fetch -q origin ${base} && git -C ${tree} merge-base --is-ancestor origin/${base} HEAD`;
};

/**
 * A landed milestone of a base run is the owner's to merge; catherd pushes its branch only when the owner answers
 * `push` (plan 35), and then asks again with the MR command. It never opens an MR and never merges.
 */
function pushQuestion(s: RunState, m: MilestoneState): string {
  const branch = m.branch ?? "the run's branch";
  if (m.mr !== null)
    return `${m.id}'s branch ${branch} is pushed to origin. Open its MR: ${m.mr}, and merge it with a merge commit; right before the merge run ${precheck(s, m)}. Answer once it is merged.`;
  const tree = m.tree ?? ".";
  return `${m.id} landed on ${branch} at ${(m.commit ?? "").slice(0, 12)}. Answer push and catherd pushes it (git -C ${tree} push -u origin ${branch}); or push it yourself. Then open its MR with ${m.digestPath ?? "its digest"} as the body, and merge it with a merge commit; right before the merge run ${precheck(s, m)}. Answer once it is merged; in a repo that squash-merges, catherd cannot see the merge, so your answer is what unblocks the milestones after it.`;
}

/**
 * Plan 34: a run whose milestones all finished asks a judge to review the repo's standing rules, then finishes with
 * its proposals. The run never waits on the owner for it, and a judge that cannot answer ends the run without one.
 */
function rulesReviewActions(s: RunState): Action[] {
  const review = s.rulesReview;
  if (review)
    return [{ type: "finish", outcome: "done", ...(review.failed ? {} : { proposals: review.changes }) }];
  if (Object.values(s.dispatches).some((d) => d.name === judgeName("rules"))) return judgeRetries(s);
  return [{ type: "judge", input: judgeInputFor(s, "rules", "rules", RUN_UNIT) }];
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
        parks.push(
          m.pushing
            ? { type: "pushBranch", milestone: m.id }
            : { type: "park", unit: m.id, question: pushQuestion(s, m), reason: "push" },
        );
  if (s.stuck[RUN_UNIT] || s.questions[RUN_UNIT]) return parks;
  if (s.phase === "planning") return [...parks, ...planningActions(s)];
  if (s.phase === "approval") return [...parks, ...approvalActions(s)];
  if (s.planDirty) return [...parks, { type: "readPlan" }];
  if (s.milestones.length > 0 && s.milestones.every((m) => isFinished(s, m)))
    return [...parks, ...rulesReviewActions(s)];
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
    case "question.answered": {
      // the owner's word that a landed milestone is merged: its clean worktree goes (checkMerged removes it)
      const m = s.base !== null ? s.milestones.find((x) => x.id === e.unit) : undefined;
      return m?.status === "merged" && m.tree !== null ? [{ type: "checkMerged", milestone: m.id }] : [];
    }
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
          text: `The run ${e.outcome === "done" ? "finished" : e.outcome === "cancelled" ? "was cancelled" : "stopped"}${e.reportPath ? `: ${e.reportPath}` : ""}${
            s.rulesReview?.changes.length
              ? `; ${s.rulesReview.changes.length} proposed change(s) to the standing rules wait in the report`
              : ""
          }`,
        },
        { type: "notify", unit: RUN_UNIT, moment: "finish" },
      ];
    default:
      return [];
  }
}

/** The reports and notices still owed: a park's and a landing's, until their `report.posted`. */
function owedActions(s: RunState): Action[] {
  const reminders: RemindAction[] =
    s.phase === "ended"
      ? []
      : Object.values(s.questions)
          .filter((q) => remindDue(q) <= s.at)
          .map((q) => ({ type: "remind", unit: q.unit, n: (q.reminded ?? 0) + 1 }));
  return [
    ...reminders,
    ...Object.values(s.owed)
      .filter((o) => (s.failedEffects[`report@${o.unit}`] ?? 0) < MAX_TRIES)
      .flatMap((o): Action[] => [
        { type: "report", kind: o.kind, unit: o.unit, text: o.text },
        ...(o.moment !== null ? [{ type: "notify" as const, unit: o.unit, moment: o.moment }] : []),
      ]),
  ];
}

/** What a pause holds back: every new step, a worktree claim and a routing included; a live role's check and commit still run. */
const PAUSED_STEPS = new Set<Action["type"]>([
  "dispatch",
  "judge",
  "machineCheck",
  "land",
  "pushBranch",
  "integrate",
  "claimTree",
  "route",
]);

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
    if (state.paused !== null && PAUSED_STEPS.has(a.type)) return false;
    seen.add(key);
    return true;
  });
}

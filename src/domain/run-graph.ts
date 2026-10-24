import { z } from "zod";
import { tryParseRung } from "./ids.ts";
import { JUDGE_KINDS, type JudgeKind } from "./judge.ts";
import type { RunRecord } from "./record.ts";
import { ROLES } from "./roles.ts";
import { describeEvent, PARK_REASONS, type ParkReason, RUN_UNIT, type RunEvent } from "./run-events.ts";
import {
  type DispatchView,
  integrateName,
  lanesOf,
  milestoneOf,
  type MilestoneState,
  type MilestoneStatus,
  type RunState,
} from "./run-state.ts";

/**
 * The run model (panel v2, spec A): the nodes, attempts and edges a run page draws, folded from the run's
 * events and dispatch records. Pure: the same inputs give the same model, and `diffRunModel` gives the patch.
 */
export const NODE_KINDS = [
  "start",
  "architect",
  "later",
  "route",
  "preflight",
  "lane",
  "check",
  "commit",
  "review",
  "verify",
  "integrate",
  "land",
  "judge",
  "report",
  "end",
] as const;
export const NODE_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "parked",
  "skipped",
  "cancelled",
] as const;
type NodeStatus = (typeof NODE_STATUSES)[number];

export const AttemptSchema = z.object({
  /** the dispatchId, or `<kind>:<seq>` for an event attempt */
  id: z.string(),
  kind: z.enum(["dispatch", "check", "commit", "event"]),
  label: z.string(),
  round: z.number().int().nullable(),
  status: z.enum(NODE_STATUSES),
  at: z.string(),
  endedAt: z.string().nullable(),
  dispatchId: z.string().nullable(),
  name: z.string().nullable(),
  role: z.string().nullable(),
  rung: z.string().nullable(),
  failoverFrom: z.string().nullable(),
  judge: z.enum(JUDGE_KINDS).nullable(),
  secs: z.number().nullable(),
  tokens: z
    .object({ input: z.number(), cached: z.number(), cacheWrite: z.number().optional(), output: z.number() })
    .nullable(),
  costUsd: z.number().nullable(),
  commit: z.string().nullable(),
  exit: z.number().int().nullable(),
  text: z.string().nullable(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const RunNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  milestone: z.string().nullable(),
  lane: z.string().nullable(),
  role: z.enum(ROLES).nullable(),
  title: z.string(),
  status: z.enum(NODE_STATUSES),
  now: z.string(),
  rung: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  question: z.object({ unit: z.string(), reason: z.enum(PARK_REASONS), question: z.string() }).nullable(),
  /** newest first */
  attempts: z.array(AttemptSchema),
});
export type RunNode = z.infer<typeof RunNodeSchema>;

export const EdgeSchema = z.object({ from: z.string(), to: z.string() });
export type Edge = z.infer<typeof EdgeSchema>;

export const RunModelSchema = z.object({
  run: z.string(),
  engine: z.enum(["2.0", "1.5"]),
  seq: z.number().int(),
  phase: z.enum(["planning", "approval", "running", "ended"]).nullable(),
  outcome: z.enum(["done", "cancelled", "failed"]).nullable(),
  nodes: z.array(RunNodeSchema),
  edges: z.array(EdgeSchema),
  /** every dispatch attempt, newest first (the 1.5 page's table) */
  dispatches: z.array(AttemptSchema),
});
export type RunModel = z.infer<typeof RunModelSchema>;

export const RunModelPatchSchema = z.object({
  seq: z.number().int(),
  phase: RunModelSchema.shape.phase,
  outcome: RunModelSchema.shape.outcome,
  nodes: z.array(RunNodeSchema),
  removed: z.array(z.string()),
  edges: z.array(EdgeSchema).nullable(),
});
export type RunModelPatch = z.infer<typeof RunModelPatchSchema>;

const BACKEND: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  claude: "Claude",
  opencode: "opencode",
  cursor: "Cursor",
};
const DOING: Record<string, string> = {
  architect: "writing the plan",
  worker: "writing the code",
  reviewer: "reviewing the commit",
  "ui-reviewer": "reviewing the interface",
  verifier: "checking the acceptance lines",
  artist: "making the images",
  writer: "writing the docs",
  researcher: "researching",
  judge: "deciding",
};

/** How far a milestone has come; a parked one counts as the step it parked from. */
const RANK: Record<MilestoneStatus, number> = {
  waiting: 0,
  routing: 1,
  lanes: 2,
  fixing: 2,
  committing: 3,
  review: 4,
  verifying: 5,
  integrating: 6,
  landing: 7,
  landed: 8,
  merged: 8,
  parked: 0,
};
const STEP_RANK = { commit: 3, review: 4, verify: 5, integrate: 6, land: 7 } as const;
const rankOf = (m: MilestoneState): number =>
  RANK[m.status === "parked" ? (m.parkedFrom ?? "waiting") : m.status];

const PARKED_FROM: Partial<Record<MilestoneStatus, string>> = {
  routing: "route",
  lanes: "route",
  committing: "commit",
  review: "review",
  fixing: "review",
  verifying: "verify",
  integrating: "integrate",
  landing: "land",
};
const MILESTONE_REASON: Partial<Record<ParkReason, string>> = {
  preflight: "preflight",
  confirm: "preflight",
  commit: "commit",
  blocker: "review",
  judge: "review",
  verifier: "verify",
  land: "land",
  push: "land",
};

/** The one node an open question belongs to (Ruling 14). */
export function nodeForUnit(s: RunState, unit: string, reason: ParkReason): string {
  const lane = s.lanes[unit];
  if (lane) return `${lane.milestone}/lane/${lane.id}`;
  const m = milestoneOf(s, unit);
  if (m) {
    const step = MILESTONE_REASON[reason] ?? PARKED_FROM[m.parkedFrom ?? "waiting"] ?? "route";
    return `${m.id}/${step}`;
  }
  if (unit === RUN_UNIT && (reason === "approval" || s.phase === "planning" || s.phase === "approval"))
    return "architect";
  return "start";
}

interface Draft {
  id: string;
  kind: RunNode["kind"];
  milestone: string | null;
  lane: string | null;
  role: RunNode["role"];
  title: string;
}

const dispatchStatus = (dv: DispatchView): NodeStatus =>
  dv.ended === null
    ? "running"
    : dv.ended.status === "ok"
      ? "done"
      : dv.ended.status === "cancelled"
        ? "cancelled"
        : "failed";

/** One dispatch record as an attempt (a 1.5 run lists these; a 2.0 run adds the label and the status its events give). */
export function recordAttempt(r: RunRecord): Attempt {
  return {
    id: r.dispatchId,
    kind: "dispatch",
    label: `attempt ${r.attempt}`,
    round: null,
    status: r.status === "ok" ? "done" : r.status === "cancelled" ? "cancelled" : "failed",
    at: r.startedAt,
    endedAt: r.endedAt,
    dispatchId: r.dispatchId,
    name: r.name,
    role: r.role,
    rung: r.rung,
    failoverFrom: r.failoverFrom,
    judge: null,
    secs: r.secs,
    tokens: r.tokens,
    costUsd: r.costUsd,
    commit: null,
    exit: r.exitCode,
    text: r.replyWhy ?? r.error?.message ?? null,
  };
}

const firstLine = (s: string): string => s.split("\n")[0]?.trim() ?? "";

export function deriveRunModel(i: {
  run: string;
  state: RunState;
  events: RunEvent[];
  records: RunRecord[];
}): RunModel {
  const { state: s, events } = i;
  const records = new Map(i.records.map((r) => [r.dispatchId, r]));
  const planned = events.some((e) => e.type === "plan.ready");
  const ended = s.phase === "ended";
  const rungOf = (id: string) => s.dispatches[id]?.rung;

  // ---- the shape: nodes in protocol order, edges between them ----
  const drafts: Draft[] = [];
  const edges: Edge[] = [];
  const link = (from: string, to: string) => {
    if (!edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to });
  };
  const add = (id: string, kind: Draft["kind"], title: string, o: Partial<Draft> = {}) =>
    drafts.push({ id, kind, milestone: null, lane: null, role: null, title, ...o });

  add("start", "start", "Run");
  add("architect", "architect", "Plan", { role: "architect" });
  link("start", "architect");
  if (!planned) {
    add("later", "later", "Milestones");
    link("architect", "later");
  } else {
    const ids = new Set(s.milestones.map((m) => m.id));
    const needed = new Set<string>();
    for (const m of s.milestones) for (const a of m.after) if (ids.has(a)) needed.add(a);
    for (const m of s.milestones) {
      const p = (step: string) => `${m.id}/${step}`;
      const lanes = lanesOf(s, m.id);
      const laneIds = new Set(lanes.map((l) => l.id));
      const after = (l: (typeof lanes)[number]) => l.after.filter((a) => laneIds.has(a));
      const followed = new Set(lanes.flatMap(after));
      const integrate =
        s.base !== null ||
        events.some(
          (e) =>
            (e.type === "base.behind" || e.type === "integrate.done" || e.type === "integrate.conflict") &&
            e.milestone === m.id,
        ) ||
        Object.values(s.dispatches).some((d) => d.name === integrateName(m.id));
      add(p("route"), "route", `${m.id} route`, { milestone: m.id });
      add(p("preflight"), "preflight", `${m.id} preflight`, { milestone: m.id });
      for (const l of lanes) {
        add(p(`lane/${l.id}`), "lane", `${l.id} ${l.role}`, { milestone: m.id, lane: l.id, role: l.role });
        add(p(`check/${l.id}`), "check", `${l.id} fast check`, { milestone: m.id, lane: l.id });
      }
      add(p("commit"), "commit", `${m.id} commit`, { milestone: m.id });
      add(p("review"), "review", `${m.id} review`, { milestone: m.id, role: "reviewer" });
      add(p("verify"), "verify", `${m.id} verify`, { milestone: m.id, role: "verifier" });
      if (integrate) add(p("integrate"), "integrate", `${m.id} integrate`, { milestone: m.id });
      add(p("land"), "land", `${m.id} land`, { milestone: m.id });

      const deps = m.after.filter((a) => ids.has(a));
      if (deps.length === 0) link("architect", p("route"));
      for (const a of deps) link(`${a}/land`, p("route"));
      link(p("route"), p("preflight"));
      for (const l of lanes) {
        const from = after(l);
        if (from.length === 0) link(p("preflight"), p(`lane/${l.id}`));
        for (const a of from) link(p(`check/${a}`), p(`lane/${l.id}`));
        link(p(`lane/${l.id}`), p(`check/${l.id}`));
        if (!followed.has(l.id)) link(p(`check/${l.id}`), p("commit"));
      }
      if (lanes.length === 0) link(p("preflight"), p("commit"));
      link(p("commit"), p("review"));
      link(p("review"), p("verify"));
      if (integrate) {
        link(p("verify"), p("integrate"));
        link(p("integrate"), p("land"));
      } else link(p("verify"), p("land"));
    }
    add("judge", "judge", "Rules review", { role: "judge" });
    add("report", "report", "Report");
    add("end", "end", "End");
    const last = s.milestones.filter((m) => !needed.has(m.id));
    for (const m of last) link(`${m.id}/land`, "judge");
    if (last.length === 0) link("architect", "judge");
    link("judge", "report");
    link("report", "end");
  }
  const has = new Set(drafts.map((d) => d.id));

  // ---- the attempts: one pass over the events ----
  const commits: Record<string, number> = {};
  const judgeKinds = new Map<string, JudgeKind>();
  for (const e of events) {
    if (e.type === "dispatch.started" && e.judgeKind) judgeKinds.set(e.dispatchId, e.judgeKind);
    if (e.type === "judge.decided") judgeKinds.set(e.dispatchId, e.kind);
  }
  const byNode = new Map<string, Attempt[]>();
  const push = (node: string | null, a: Attempt) => {
    if (node === null || !has.has(node)) return;
    byNode.set(node, [...(byNode.get(node) ?? []), a]);
  };
  const all: Attempt[] = [];

  const judgeNode = (unit: string): string => {
    const lane = s.lanes[unit];
    if (lane) return `${lane.milestone}/lane/${lane.id}`;
    return milestoneOf(s, unit) ? `${unit}/review` : "architect";
  };
  /** Where a dispatch lands and what its attempt is called. */
  const place = (dv: DispatchView, rec: RunRecord | undefined): { node: string | null; label: string } => {
    const before = commits[milestoneOf(s, dv.unit)?.id ?? s.lanes[dv.lane ?? ""]?.milestone ?? ""] ?? 0;
    const lane = dv.lane ? s.lanes[dv.lane] : undefined;
    if (dv.role === "judge") {
      if (dv.name === "judge-rules") return { node: "judge", label: "rules" };
      return { node: judgeNode(dv.unit), label: `judge (${judgeKinds.get(dv.dispatchId) ?? "unexpected"})` };
    }
    if (lane)
      return {
        node: `${lane.milestone}/lane/${lane.id}`,
        label: rec?.failoverFrom ? `failover from ${rec.failoverFrom}` : `round ${before}`,
      };
    if (dv.role === "architect") {
      const fix = /^architect-(.+)-\d+$/.exec(dv.name);
      return { node: "architect", label: fix ? `${fix[1]} fix plan` : "plan" };
    }
    if (dv.role === "researcher") return { node: "architect", label: "dossier" };
    const m = milestoneOf(s, dv.unit);
    if (!m) return { node: null, label: dv.name };
    if (dv.name === integrateName(m.id)) return { node: `${m.id}/integrate`, label: "resolving the merge" };
    const round = `round ${Math.max(0, before - 1)}`;
    if (dv.role === "ui-reviewer") return { node: `${m.id}/review`, label: "UI review" };
    if (dv.role === "reviewer")
      return { node: `${m.id}/review`, label: dv.name.endsWith("-2") ? "second review" : round };
    if (dv.role === "verifier") return { node: `${m.id}/verify`, label: round };
    return { node: null, label: dv.name };
  };

  const event = (
    e: RunEvent,
    kind: Attempt["kind"],
    label: string,
    status: NodeStatus,
    o: Partial<Attempt> = {},
  ): Attempt => ({
    id: `${kind}:${e.seq}`,
    kind,
    label,
    round: null,
    status,
    at: e.at,
    endedAt: e.at,
    dispatchId: null,
    name: null,
    role: null,
    rung: null,
    failoverFrom: null,
    judge: null,
    secs: null,
    tokens: null,
    costUsd: null,
    commit: null,
    exit: null,
    text: describeEvent(e, rungOf),
    ...o,
  });

  for (const e of events) {
    const done = (node: string, label: string, failed = false) =>
      push(node, event(e, "event", label, failed ? "failed" : "done"));
    switch (e.type) {
      case "dispatch.started": {
        const dv = s.dispatches[e.dispatchId];
        if (!dv) break;
        const rec = records.get(e.dispatchId);
        const { node, label } = place(dv, rec);
        const base = rec ? recordAttempt(rec) : null;
        const judge =
          dv.role === "judge" ? (e.judgeKind ?? judgeKinds.get(e.dispatchId) ?? "unexpected") : null;
        const a: Attempt = {
          ...(base ?? {
            tokens: null,
            costUsd: null,
            secs: null,
            exit: null,
            text: null,
            failoverFrom: null,
          }),
          id: dv.dispatchId,
          kind: "dispatch",
          label,
          round: null,
          status: dispatchStatus(dv),
          at: dv.startedAt,
          endedAt: dv.ended?.at ?? null,
          dispatchId: dv.dispatchId,
          name: dv.name,
          role: dv.role,
          rung: dv.rung,
          judge,
          commit: null,
        };
        push(node, a);
        all.push(a);
        break;
      }
      case "check.ran": {
        const l = s.lanes[e.lane];
        if (!l) break;
        const round = commits[l.milestone] ?? 0;
        // plan 40's start or duration makes the attempt span its own run; with neither it stays one instant
        const end = Date.parse(e.at);
        const startMs = e.startedAt
          ? Date.parse(e.startedAt)
          : e.durationMs !== undefined
            ? end - e.durationMs
            : NaN;
        const span = Number.isFinite(startMs)
          ? {
              at: new Date(startMs).toISOString(),
              secs: e.durationMs !== undefined ? e.durationMs / 1000 : (end - startMs) / 1000,
            }
          : {};
        push(
          `${l.milestone}/check/${l.id}`,
          event(e, "check", `round ${round}`, e.exit === 0 ? "done" : "failed", {
            round,
            exit: e.exit,
            ...span,
          }),
        );
        break;
      }
      case "commit.made":
      case "commit.failed": {
        const made = e.type === "commit.made";
        push(
          `${e.milestone}/commit`,
          event(e, "commit", `round ${e.round}`, made ? "done" : "failed", {
            round: e.round,
            commit: made ? e.commit : null,
          }),
        );
        if (made) commits[e.milestone] = (commits[e.milestone] ?? 0) + 1;
        break;
      }
      case "lane.climbed": {
        const l = s.lanes[e.lane];
        if (l) done(`${l.milestone}/lane/${l.id}`, `climbed to ${e.rung}`);
        break;
      }
      case "tree.ready":
        done(`${e.milestone}/route`, "worktree ready");
        break;
      case "tree.deferred":
        done(`${e.milestone}/route`, "waiting for memory");
        break;
      case "preflight.done":
        done(`${e.milestone}/preflight`, "preflight");
        break;
      case "base.behind":
        done(`${e.milestone}/integrate`, "behind the base");
        break;
      case "integrate.done":
        done(`${e.milestone}/integrate`, "base merged");
        break;
      case "integrate.conflict":
        done(`${e.milestone}/integrate`, "merge conflict", true);
        break;
      case "milestone.landed":
        done(`${e.milestone}/land`, "landed");
        break;
      case "land.refused":
        done(`${e.milestone}/land`, "landing refused", true);
        break;
      case "branch.pushed":
        done(`${e.milestone}/land`, "branch pushed");
        break;
      case "judge.failed":
        done(e.id === "rules" ? "judge" : judgeNode(e.unit), "judge failed", true);
        break;
      default:
        break;
    }
  }
  const attemptsOf = (id: string): Attempt[] => [...(byNode.get(id) ?? [])].reverse();

  // ---- the questions: each to exactly one node ----
  const questions = new Map<string, NonNullable<RunNode["question"]>>();
  if (!ended)
    for (const q of Object.values(s.questions)) {
      let id = nodeForUnit(s, q.unit, q.reason);
      if (!has.has(id)) id = "start";
      if (!questions.has(id)) questions.set(id, { unit: q.unit, reason: q.reason, question: q.question });
    }

  // ---- the statuses ----
  const titles = new Map(drafts.map((d) => [d.id, d.title]));
  const fromTitles = (id: string): string[] =>
    edges.filter((e) => e.to === id).map((e) => titles.get(e.from) ?? e.from);
  const live = (d: Draft): Attempt[] =>
    attemptsOf(d.id).filter((a) => a.kind === "dispatch" && a.status === "running");
  const outcome = s.outcome;
  const reportDone = ended && events.some((e) => e.type === "run.ended" && e.reportPath !== null);
  const rolesOff = (r: string) => s.rolesOff.some((x) => x === r);

  const nodes: RunNode[] = drafts.map((d) => {
    const attempts = attemptsOf(d.id);
    const newest = attempts[0];
    const lane = d.lane ? s.lanes[d.lane] : undefined;
    const m = d.milestone ? milestoneOf(s, d.milestone) : undefined;
    const q = questions.get(d.id) ?? null;
    const liveOnes = live(d);
    const checking = d.kind === "check" && lane?.status === "checking";

    const stepStatus = (k: keyof typeof STEP_RANK): NodeStatus => {
      if (!m) return "pending";
      const rank = rankOf(m);
      const r = STEP_RANK[k];
      return rank > r ? "done" : rank === r ? "running" : attempts.length > 0 ? "done" : "pending";
    };
    const base = (): NodeStatus => {
      switch (d.kind) {
        case "start":
          return "done";
        case "later":
          return "pending";
        case "architect":
          return planned ? "done" : s.phase === "planning" ? "running" : "pending";
        case "route":
          return events.some((e) => e.type === "lanes.routed" && e.milestone === d.milestone)
            ? "done"
            : "pending";
        case "preflight": {
          const p = events.findLast((e) => e.type === "preflight.done" && e.milestone === d.milestone);
          if (p?.type !== "preflight.done") return "pending";
          return p.blocking.length === 0 && (!p.confirm || p.confirm.length === 0 || m?.confirmed)
            ? "done"
            : "pending";
        }
        case "lane":
          return lane ? (lane.status === "checking" ? "done" : lane.status) : "pending";
        case "check":
          return checking ? "running" : (newest?.status ?? "pending");
        case "commit":
        case "review":
        case "verify":
        case "integrate":
        case "land":
          return stepStatus(d.kind);
        case "judge":
          return s.rulesReview ? (s.rulesReview.failed ? "failed" : "done") : "pending";
        case "report":
          return reportDone ? "done" : "pending";
        case "end":
          return ended
            ? outcome === "done"
              ? "done"
              : outcome === "cancelled"
                ? "cancelled"
                : "failed"
            : "pending";
      }
    };

    let status: NodeStatus;
    if (q) status = "parked";
    else if (liveOnes.length > 0 || checking) status = "running";
    else if (
      (d.kind === "review" && rolesOff("reviewer") && attempts.length === 0) ||
      (d.kind === "verify" && rolesOff("verifier")) ||
      (d.kind === "judge" && rolesOff("judge"))
    )
      status = "skipped";
    else {
      status = base();
      if (d.kind !== "end" && newest?.status === "failed") status = "failed";
    }
    if (ended && d.kind !== "end") {
      if (status === "running" || status === "parked") status = outcome === "failed" ? "failed" : "cancelled";
      else if (status === "pending") status = "skipped";
    }

    const rung = attempts.find((a) => a.kind === "dispatch")?.rung ?? lane?.rung ?? null;
    return {
      id: d.id,
      kind: d.kind,
      milestone: d.milestone,
      lane: d.lane,
      role: d.role,
      title: d.title,
      status,
      now: nowLine(d, status, {
        q,
        newest,
        liveOne: liveOnes[0],
        unitOf: (id) => s.dispatches[id]?.unit ?? RUN_UNIT,
        from: fromTitles(d.id),
        checking,
        committing: d.kind === "commit" && status === "running",
        lane: d.lane,
        milestone: d.milestone,
      }),
      rung,
      startedAt: attempts.at(-1)?.at ?? (d.kind === "start" ? (events[0]?.at ?? null) : null),
      endedAt:
        status === "running" || status === "parked" || status === "pending"
          ? null
          : d.kind === "end" || d.kind === "report"
            ? (events.findLast((e) => e.type === "run.ended")?.at ?? null)
            : (attempts.reduce<string | null>(
                (late, a) => (a.endedAt && (!late || a.endedAt > late) ? a.endedAt : late),
                null,
              ) ?? (d.kind === "start" ? (events[0]?.at ?? null) : null)),
      question: q,
      attempts,
    };
  });

  return {
    run: i.run,
    engine: "2.0",
    seq: s.seq,
    phase: s.phase,
    outcome: s.outcome,
    nodes,
    edges,
    dispatches: all.reverse(),
  };
}

function nowLine(
  d: Draft,
  status: NodeStatus,
  c: {
    q: RunNode["question"];
    newest: Attempt | undefined;
    liveOne: Attempt | undefined;
    unitOf: (dispatchId: string) => string;
    from: string[];
    checking: boolean;
    committing: boolean;
    lane: string | null;
    milestone: string | null;
  },
): string {
  switch (status) {
    case "parked":
      return c.q?.reason === "approval"
        ? "Waiting for you to approve the plan"
        : c.q
          ? `Waiting for your answer: ${firstLine(c.q.question)}`
          : "Waiting for a decision";
    case "running": {
      if (c.liveOne) {
        const backend = tryParseRung(c.liveOne.rung ?? "")?.backend ?? "";
        const unit = c.unitOf(c.liveOne.id);
        return `${BACKEND[backend] ?? "An agent"} is ${DOING[c.liveOne.role ?? ""] ?? "working"} for ${unit === RUN_UNIT ? "the run" : unit}`;
      }
      if (c.checking) return `Running the fast check for ${c.lane}`;
      if (c.committing) return `Committing ${c.milestone}`;
      return "In progress";
    }
    case "pending":
      return d.kind === "later"
        ? "Known once the plan is ready"
        : c.from.length > 0
          ? `Starts after ${c.from.join(", ")}`
          : "Waiting to start";
    case "done":
      return "Done";
    case "failed":
      return c.newest ? `Failed: ${c.newest.text ?? c.newest.label}` : "Failed";
    case "skipped":
      return "Skipped";
    case "cancelled":
      return "Cancelled";
  }
}

/** What changed from `a` to `b`: the new or changed nodes, the removed ids, and the edges only when they changed. */
export function diffRunModel(a: RunModel, b: RunModel): RunModelPatch {
  const before = new Map(a.nodes.map((n) => [n.id, JSON.stringify(n)]));
  const now = new Set(b.nodes.map((n) => n.id));
  return {
    seq: b.seq,
    phase: b.phase,
    outcome: b.outcome,
    nodes: b.nodes.filter((n) => before.get(n.id) !== JSON.stringify(n)),
    removed: a.nodes.filter((n) => !now.has(n.id)).map((n) => n.id),
    edges: JSON.stringify(a.edges) === JSON.stringify(b.edges) ? null : b.edges,
  };
}

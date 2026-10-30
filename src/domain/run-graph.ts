import { z } from "zod";
import { RunFlowSchema } from "./run-flow.ts";
import { tryParseRung } from "./ids.ts";
import type { RunRecord } from "./record.ts";
import { ROLES } from "./roles.ts";
import { describeEvent, PARK_REASONS, type ParkReason, RUN_UNIT, type RunEvent } from "./run-events.ts";
import type { DispatchView, RunState } from "./run-state.ts";

/** The judge's call kinds an earlier build's run may show; plan 48 deleted the judge, so a new attempt has none. */
const JUDGE_KINDS = ["triage", "question", "unexpected", "rules"] as const;

/**
 * The run model (panel v2, spec A): the nodes, attempts and edges a run page draws, folded from the run's
 * events and dispatch records. Pure: the same inputs give the same model, and `diffRunModel` gives the patch.
 * Plan 48: the run is the architect's; its turns are one node, each task it delegated and each check one more.
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
  flow: RunFlowSchema.nullable(),
});
export type RunModel = z.infer<typeof RunModelSchema>;

export const RunModelPatchSchema = z.object({
  seq: z.number().int(),
  phase: RunModelSchema.shape.phase,
  outcome: RunModelSchema.shape.outcome,
  nodes: z.array(RunNodeSchema),
  removed: z.array(z.string()),
  edges: z.array(EdgeSchema).nullable(),
  flow: RunFlowSchema.nullable(),
});
export type RunModelPatch = z.infer<typeof RunModelPatchSchema>;

const BACKEND: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  claude: "Claude",
  opencode: "opencode",
};
const DOING: Record<string, string> = {
  architect: "driving the run",
  worker: "writing the code",
  reviewer: "reviewing the work",
  verifier: "checking the acceptance lines",
  artist: "making the images",
  writer: "writing the docs",
  researcher: "researching",
};

/** The one node an open question belongs to: the task it names, else the architect. */
export function nodeForUnit(s: RunState, unit: string, _reason: ParkReason): string {
  if (/^T\d+$/.test(unit)) return `task/${unit}`;
  if (unit === RUN_UNIT) return "architect";
  // an earlier build's unit (spec D16): the node of the last role that worked it
  const d = Object.values(s.dispatches).findLast((x) => x.unit === unit && x.role !== "architect");
  return d ? `task/${d.name}` : "start";
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

/** The node kind a delegated task draws as: the existing kinds, so the panel needs no change (plan 48 R12). */
const KIND_OF_ROLE: Partial<Record<string, RunNode["kind"]>> = {
  reviewer: "review",
  verifier: "verify",
};

export function deriveRunModel(i: {
  run: string;
  state: RunState;
  events: RunEvent[];
  records: RunRecord[];
}): RunModel {
  const { state: s, events } = i;
  const records = new Map(i.records.map((r) => [r.dispatchId, r]));
  const ended = s.phase === "ended";
  const rungOf = (id: string) => s.dispatches[id]?.rung;
  const a = s.arch;

  // ---- the shape: the start, the architect, its tasks and checks in the order it asked, the end ----
  const drafts: Draft[] = [];
  const edges: Edge[] = [];
  const add = (id: string, kind: Draft["kind"], title: string, o: Partial<Draft> = {}) =>
    drafts.push({ id, kind, milestone: null, lane: null, role: null, title, ...o });
  add("start", "start", "Run");
  add("architect", "architect", "Architect", { role: "architect" });
  edges.push({ from: "start", to: "architect" });
  for (const e of events) {
    if (e.type === "task.delegated" && !drafts.some((d) => d.id === `task/${e.taskId}`)) {
      add(`task/${e.taskId}`, KIND_OF_ROLE[e.role] ?? "lane", `${e.taskId} ${e.role}`, {
        lane: e.taskId,
        role: e.role,
      });
      edges.push({ from: "architect", to: `task/${e.taskId}` });
    } else if (
      // an earlier build's run (spec D16) dispatched roles no task names: each draws as a node of its own
      e.type === "dispatch.started" &&
      e.role !== "architect" &&
      !drafts.some((d) => d.id === `task/${e.name}`)
    ) {
      add(`task/${e.name}`, KIND_OF_ROLE[e.role] ?? "lane", `${e.unit} ${e.role}`, {
        lane: e.lane,
        role: e.role,
      });
      edges.push({ from: "architect", to: `task/${e.name}` });
    } else if (e.type === "check.requested" && !drafts.some((d) => d.id === `check/${e.checkId}`)) {
      add(`check/${e.checkId}`, "check", `${e.checkId} ${e.scope} check`);
      edges.push({ from: "architect", to: `check/${e.checkId}` });
    }
  }
  add("end", "end", "End");
  edges.push({ from: "architect", to: "end" });
  const has = new Set(drafts.map((d) => d.id));

  // ---- the attempts: one pass over the events ----
  const byNode = new Map<string, Attempt[]>();
  const push = (node: string | null, at: Attempt) => {
    if (node === null || !has.has(node)) return;
    byNode.set(node, [...(byNode.get(node) ?? []), at]);
  };
  const all: Attempt[] = [];
  const nodeOf = (dv: DispatchView): string => (dv.role === "architect" ? "architect" : `task/${dv.name}`);

  for (const e of events) {
    if (e.type === "dispatch.started") {
      const dv = s.dispatches[e.dispatchId];
      if (!dv) continue;
      const rec = records.get(e.dispatchId);
      const base = rec ? recordAttempt(rec) : null;
      const at: Attempt = {
        ...(base ?? { tokens: null, costUsd: null, secs: null, exit: null, text: null, failoverFrom: null }),
        id: dv.dispatchId,
        kind: "dispatch",
        label: dv.role === "architect" ? `turn ${dv.name.replace(/^architect-/, "")}` : dv.name,
        round: null,
        status: dispatchStatus(dv),
        at: dv.startedAt,
        endedAt: dv.ended?.at ?? null,
        dispatchId: dv.dispatchId,
        name: dv.name,
        role: dv.role,
        rung: dv.rung,
        judge: null,
        commit: null,
      };
      push(nodeOf(dv), at);
      all.push(at);
    } else if (e.type === "check.done") {
      push(`check/${e.checkId}`, {
        id: `check:${e.seq}`,
        kind: "check",
        label: e.cached ? "cached pass" : e.verdict === "inherited" ? "passed (inherited failures)" : "run",
        round: null,
        // an inherited failure counts as passing for land final (plan 52)
        status: e.exit === 0 || e.verdict === "inherited" ? "done" : "failed",
        at: new Date(Date.parse(e.at) - e.minutes * 60_000).toISOString(),
        endedAt: e.at,
        dispatchId: null,
        name: null,
        role: null,
        rung: null,
        failoverFrom: null,
        judge: null,
        secs: e.minutes * 60,
        tokens: null,
        costUsd: null,
        commit: null,
        exit: e.exit,
        text: describeEvent(e, rungOf),
      });
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
  const outcome = s.outcome;
  const nodes: RunNode[] = drafts.map((d) => {
    const attempts = attemptsOf(d.id);
    const newest = attempts[0];
    const q = questions.get(d.id) ?? null;
    const liveOne = attempts.find((x) => x.kind === "dispatch" && x.status === "running");
    const task = d.lane ? a.tasks[d.lane] : undefined;
    const check = d.kind === "check" ? a.checks[d.id.slice("check/".length)] : undefined;
    const base = (): NodeStatus => {
      if (d.kind === "start") return "done";
      if (d.kind === "end")
        return ended
          ? outcome === "done"
            ? "done"
            : outcome === "cancelled"
              ? "cancelled"
              : "failed"
          : "pending";
      if (d.kind === "architect") return ended ? "done" : "pending";
      if (check) return check.state === "queued" ? "running" : (newest?.status ?? "pending");
      if (task?.state === "cancelled" || task?.state === "refused") return "cancelled";
      return newest?.status ?? "pending";
    };
    let status: NodeStatus;
    if (q) status = "parked";
    else if (liveOne) status = "running";
    else status = base();
    if (ended && d.kind !== "end") {
      if (status === "running" || status === "parked") status = outcome === "failed" ? "failed" : "cancelled";
      else if (status === "pending") status = "skipped";
    }
    return {
      id: d.id,
      kind: d.kind,
      milestone: null,
      lane: d.lane,
      role: d.role,
      title: d.title,
      status,
      now: nowLine(status, { q, newest, liveOne, unitOf: (id) => s.dispatches[id]?.unit ?? RUN_UNIT }),
      rung: attempts.find((x) => x.kind === "dispatch")?.rung ?? task?.rung ?? null,
      startedAt: attempts.at(-1)?.at ?? (d.kind === "start" ? (events[0]?.at ?? null) : null),
      endedAt:
        status === "running" || status === "parked" || status === "pending"
          ? null
          : d.kind === "end"
            ? (events.findLast((e) => e.type === "run.ended")?.at ?? null)
            : (attempts.reduce<string | null>(
                (late, x) => (x.endedAt && (!late || x.endedAt > late) ? x.endedAt : late),
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
    flow: null,
  };
}

function nowLine(
  status: NodeStatus,
  c: {
    q: RunNode["question"];
    newest: Attempt | undefined;
    liveOne: Attempt | undefined;
    unitOf: (dispatchId: string) => string;
  },
): string {
  switch (status) {
    case "parked":
      return c.q ? `Waiting for your answer: ${firstLine(c.q.question)}` : "Waiting for a decision";
    case "running": {
      if (c.liveOne) {
        const backend = tryParseRung(c.liveOne.rung ?? "")?.backend ?? "";
        const unit = c.unitOf(c.liveOne.id);
        return `${BACKEND[backend] ?? "An agent"} is ${DOING[c.liveOne.role ?? ""] ?? "working"} for ${unit === RUN_UNIT ? "the run" : unit}`;
      }
      return "In progress";
    }
    case "pending":
      return "Waiting to start";
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
    flow: b.flow,
    phase: b.phase,
    outcome: b.outcome,
    nodes: b.nodes.filter((n) => before.get(n.id) !== JSON.stringify(n)),
    removed: a.nodes.filter((n) => !now.has(n.id)).map((n) => n.id),
    edges: JSON.stringify(a.edges) === JSON.stringify(b.edges) ? null : b.edges,
  };
}

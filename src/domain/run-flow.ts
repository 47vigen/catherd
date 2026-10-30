import { z } from "zod";
import { taskAttempts } from "./architect-state.ts";
import { quotaOf } from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import { LEDGER_STATES, ledgerView, type LedgerTask } from "./ledger.ts";
import { REPLY_STATUSES, RUN_STATUSES, type RunRecord } from "./record.ts";
import { PARK_REASONS, type RunEvent } from "./run-events.ts";
import { HOLD_MS, replay } from "./run-state.ts";

export const FlowSelectionSchema = z.object({ nodeId: z.string(), attemptId: z.string().nullable() });
export const FlowIntervalSchema = z.object({ startedAt: z.string(), endedAt: z.string().nullable() });
export const FlowCauseSchema = z.object({
  seq: z.number(),
  at: z.string(),
  by: z.string(),
  why: z.string(),
  type: z.enum(["ledger.changed", "task.delegated", "check.requested"]),
  turnDispatchId: z.string().nullable(),
});
export const FlowDispatchSchema = FlowIntervalSchema.extend({
  dispatchId: z.string(),
  name: z.string(),
  role: z.string(),
  taskId: z.string().nullable(),
  ledgerTask: z.string().nullable(),
  rung: z.string(),
  status: z.enum([...RUN_STATUSES, "running"]),
  replyStatus: z.enum(REPLY_STATUSES).nullable(),
  why: z.string().nullable(),
  costUsd: z.number().nullable(),
  climbFrom: z.string().nullable(),
  selection: FlowSelectionSchema,
});
export const FlowTurnSchema = FlowDispatchSchema.extend({ causeSeqs: z.array(z.number()) });
export const FlowCheckSchema = z.object({
  checkId: z.string(),
  scope: z.string(),
  base: z.boolean(),
  command: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  exit: z.number().nullable(),
  failureCount: z.number().nullable(),
  verdict: z.enum(["pass", "inherited", "new", "unknown"]).nullable(),
  newFailures: z.number().nullable(),
  inheritedFailures: z.number().nullable(),
  failures: z.array(z.string()),
  preExisting: z.array(z.string()),
  cached: z.boolean(),
  logPath: z.string().nullable(),
  why: z.string().nullable(),
  selection: FlowSelectionSchema,
});
export const FlowTaskSchema = z.object({
  id: z.string(),
  goal: z.string(),
  state: z.enum(LEDGER_STATES),
  depends: z.array(z.string()),
  dispatchIds: z.array(z.string()),
});
export const FlowOwnerWaitSchema = FlowIntervalSchema.extend({
  unit: z.string(),
  question: z.string().nullable(),
  reason: z.enum([...PARK_REASONS, "paused"]),
  evidenceSeqs: z.array(z.number()),
});
export const FlowQuotaHoldSchema = FlowIntervalSchema.extend({
  quota: z.string(),
  until: z.string(),
  evidenceSeqs: z.array(z.number()),
});
export const FlowIdleSchema = FlowIntervalSchema.extend({
  reason: z.enum(["owner", "quota", "check", "gap"]),
  evidenceSeqs: z.array(z.number()),
});
export const RunFlowSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  asOf: z.string(),
  architect: z.array(FlowTurnSchema),
  tasks: z.array(FlowTaskSchema),
  dispatches: z.array(FlowDispatchSchema),
  checks: z.array(FlowCheckSchema),
  causes: z.array(FlowCauseSchema),
  ownerWaits: z.array(FlowOwnerWaitSchema),
  quotaHolds: z.array(FlowQuotaHoldSchema),
  idle: z.array(FlowIdleSchema),
});
export type FlowSelection = z.infer<typeof FlowSelectionSchema>;
export type FlowInterval = z.infer<typeof FlowIntervalSchema>;
export type FlowCause = z.infer<typeof FlowCauseSchema>;
export type FlowDispatch = z.infer<typeof FlowDispatchSchema>;
export type FlowTurn = z.infer<typeof FlowTurnSchema>;
export type FlowCheck = z.infer<typeof FlowCheckSchema>;
export type FlowTask = z.infer<typeof FlowTaskSchema>;
export type FlowOwnerWait = z.infer<typeof FlowOwnerWaitSchema>;
export type FlowQuotaHold = z.infer<typeof FlowQuotaHoldSchema>;
export type FlowIdle = z.infer<typeof FlowIdleSchema>;
export type RunFlow = z.infer<typeof RunFlowSchema>;
export interface FlowCheckRecord {
  checkId: string;
  scope: string;
  command: string;
  base: boolean;
  exit: number | null;
  failures: string[];
  at: string;
  cached: boolean;
  verdict?: string | null;
}
export interface RunFlowInput {
  startedAt: string;
  now: number;
  events: readonly RunEvent[];
  records: readonly RunRecord[];
  ledgerTasks: readonly LedgerTask[];
  checks: readonly FlowCheckRecord[];
}

export function deriveRunFlow(input: RunFlowInput): RunFlow {
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const endedAt = events.find((e) => e.type === "run.ended")?.at ?? null;
  const end = endedAt ? Date.parse(endedAt) : input.now;
  const asOf = new Date(end).toISOString();
  const starts = events.filter((e) => e.type === "dispatch.started");
  const ends = new Map(events.filter((e) => e.type === "dispatch.ended").map((e) => [e.dispatchId, e]));
  const records = new Map(input.records.map((r) => [r.dispatchId, r]));
  const delegations = new Map(events.filter((e) => e.type === "task.delegated").map((e) => [e.taskId, e]));
  const dispatches: FlowDispatch[] = [];
  const architect: FlowTurn[] = [];
  const all = [
    ...starts.map((s) => ({ s, r: records.get(s.dispatchId) })),
    ...input.records
      .filter((r) => !starts.some((s) => s.dispatchId === r.dispatchId))
      .map((r) => ({ s: undefined, r })),
  ];
  for (const { s, r } of all) {
    const id = s?.dispatchId ?? r!.dispatchId;
    const name = s?.name ?? r!.name;
    const role = s?.role ?? r!.role;
    const done = ends.get(id);
    const delegation = s ? delegations.get(name) : undefined;
    const d: FlowDispatch = {
      dispatchId: id,
      name,
      role,
      taskId: delegation?.taskId ?? null,
      ledgerTask: delegation?.ledgerTask ?? null,
      rung: s?.rung ?? r!.rung,
      startedAt: s?.at ?? r!.startedAt,
      endedAt: done?.at ?? r?.endedAt ?? endedAt,
      status: done?.status ?? r?.status ?? "running",
      replyStatus: done ? done.replyStatus : (r?.replyStatus ?? null),
      why:
        role === "architect"
          ? done?.why || r?.replyWhy || null
          : delegation?.why || done?.why || r?.replyWhy || null,
      costUsd: r?.costUsd ?? null,
      climbFrom: null,
      selection: { nodeId: role === "architect" ? "architect" : `task/${name}`, attemptId: id },
    };
    if (role === "architect") architect.push({ ...d, causeSeqs: [] });
    else dispatches.push(d);
  }
  const byTime = (a: FlowInterval, b: FlowInterval) => a.startedAt.localeCompare(b.startedAt);
  architect.sort(byTime);
  dispatches.sort(byTime);
  const previous = new Map<string, string>();
  for (const d of [...architect, ...dispatches].sort(byTime)) {
    const key =
      d.role === "architect" ? "architect" : d.ledgerTask === null ? null : `${d.ledgerTask}\0${d.role}`;
    if (key !== null) {
      const old = previous.get(key);
      if (old && old !== d.rung) d.climbFrom = old;
      previous.set(key, d.rung);
    }
  }
  const causes: FlowCause[] = events
    .filter((e) => e.type === "ledger.changed" || e.type === "task.delegated" || e.type === "check.requested")
    .map((e) => {
      const turns = architect.filter((t) => t.name === e.by);
      const turnDispatchId = turns.length === 1 ? turns[0]!.dispatchId : null;
      if (turnDispatchId) turns[0]!.causeSeqs.push(e.seq);
      return { seq: e.seq, at: e.at, by: e.by, why: e.why, type: e.type, turnDispatchId };
    });
  const tasks = ledgerView(input.ledgerTasks, taskAttempts(replay(events, "flow").arch)).map((t) => ({
    id: t.id,
    goal: t.goal,
    state: t.state,
    depends: [...t.depends],
    dispatchIds: dispatches.filter((d) => d.ledgerTask === t.id).map((d) => d.dispatchId),
  }));
  const reqs = events.filter((e) => e.type === "check.requested");
  const dones = events.filter((e) => e.type === "check.done");
  const checkFailures = events.flatMap((e) =>
    e.type === "effect.failed" && e.action === "runCheck" ? [e] : [],
  );
  const ids = new Set([
    ...reqs.map((e) => e.checkId),
    ...dones.map((e) => e.checkId),
    ...input.checks.map((c) => c.checkId),
  ]);
  const checks: FlowCheck[] = [...ids]
    .map((id) => {
      const req = reqs.find((e) => e.checkId === id),
        done = dones.find((e) => e.checkId === id),
        row = input.checks.find((c) => c.checkId === id),
        failed = checkFailures.find((e) => e.unit === id);
      const failures = [...(done?.failures ?? row?.failures ?? [])],
        preExisting = [...(done?.preExisting ?? [])];
      const comparable = done?.verdict && done.verdict !== "unknown";
      const inherited = comparable ? failures.filter((f) => preExisting.includes(f)).length : null;
      return {
        checkId: id,
        scope: req?.scope ?? row?.scope ?? "",
        base: req?.base ?? row?.base ?? false,
        command: req?.command ?? row?.command ?? "",
        startedAt: req?.at ?? null,
        endedAt: done?.at ?? row?.at ?? failed?.at ?? (req ? endedAt : null),
        exit: done ? done.exit : (row?.exit ?? null),
        failureCount: done || row ? failures.length : null,
        verdict: done?.verdict ?? null,
        newFailures: inherited === null ? null : failures.length - inherited,
        inheritedFailures: inherited,
        failures,
        preExisting,
        cached: done?.cached ?? row?.cached ?? false,
        logPath: done?.logPath ?? null,
        why: req?.why ?? null,
        selection: { nodeId: `check/${id}`, attemptId: done ? `check:${done.seq}` : null },
      };
    })
    .sort((a, b) => (a.startedAt ?? a.endedAt ?? "").localeCompare(b.startedAt ?? b.endedAt ?? ""));
  const ownerWaits: FlowOwnerWait[] = [],
    activeOwners = new Map<string, FlowOwnerWait>();
  const closeOwner = (key: string, at: string) => {
    const w = activeOwners.get(key);
    if (w) {
      w.endedAt = at;
      activeOwners.delete(key);
    }
  };
  const quotaHolds: FlowQuotaHold[] = [],
    activeQuotas = new Map<string, FlowQuotaHold>();
  for (const e of events) {
    if (e.type === "question.parked") {
      closeOwner(e.unit, e.at);
      const w: FlowOwnerWait = {
        unit: e.unit,
        question: e.question,
        reason: e.reason,
        startedAt: e.at,
        endedAt: null,
        evidenceSeqs: [e.seq],
      };
      ownerWaits.push(w);
      activeOwners.set(e.unit, w);
    }
    if (e.type === "question.answered") closeOwner(e.unit, e.at);
    if (e.type === "run.paused") {
      closeOwner("\0pause", e.at);
      const w: FlowOwnerWait = {
        unit: "run",
        question: null,
        reason: "paused",
        startedAt: e.at,
        endedAt: null,
        evidenceSeqs: [e.seq],
      };
      ownerWaits.push(w);
      activeOwners.set("\0pause", w);
    }
    if (e.type === "run.resumed") closeOwner("\0pause", e.at);
    if (e.type === "dispatch.ended") {
      const rung = starts.find((s) => s.dispatchId === e.dispatchId)?.rung ?? records.get(e.dispatchId)?.rung;
      const parsed = rung ? tryParseRung(rung) : null;
      if (!parsed) continue;
      const quota = quotaOf(parsed),
        existing = activeQuotas.get(quota);
      if (existing && Date.parse(existing.until) <= Date.parse(e.at)) {
        existing.endedAt = existing.until;
        activeQuotas.delete(quota);
      }
      const hold = activeQuotas.get(quota);
      if (e.status === "limit") {
        const until = new Date(Date.parse(e.at) + HOLD_MS).toISOString();
        if (hold) {
          hold.until = until;
          hold.evidenceSeqs.push(e.seq);
        } else {
          const h = { quota, startedAt: e.at, endedAt: null, until, evidenceSeqs: [e.seq] };
          quotaHolds.push(h);
          activeQuotas.set(quota, h);
        }
      } else if (e.status === "ok" && e.replyStatus === "complete" && hold) {
        hold.endedAt = e.at;
        activeQuotas.delete(quota);
      }
    }
  }
  for (const w of activeOwners.values()) w.endedAt = endedAt;
  for (const h of activeQuotas.values())
    if (Date.parse(h.until) <= end) h.endedAt = h.until;
    else h.endedAt = endedAt;
  const busy = [...architect, ...dispatches].map((d) => ({
    start: Date.parse(d.startedAt),
    end: Date.parse(d.endedAt ?? asOf),
  }));
  const sources = [
    ...ownerWaits.map((w) => ({
      start: Date.parse(w.startedAt),
      end: Date.parse(w.endedAt ?? asOf),
      reason: "owner" as const,
      seqs: w.evidenceSeqs,
    })),
    ...quotaHolds.flatMap((h) =>
      h.evidenceSeqs.map((seq) => ({
        start: Date.parse(events.find((e) => e.seq === seq)!.at),
        end: Date.parse(h.endedAt ?? asOf),
        reason: "quota" as const,
        seqs: [seq],
      })),
    ),
    ...checks
      .filter((c) => c.startedAt !== null)
      .map((c) => ({
        start: Date.parse(c.startedAt!),
        end: Date.parse(c.endedAt ?? asOf),
        reason: "check" as const,
        seqs: [reqs.find((e) => e.checkId === c.checkId)!.seq],
      })),
  ];
  const start = Date.parse(input.startedAt);
  const points = [
    ...new Set(
      [
        start,
        end,
        ...busy.flatMap((x) => [x.start, x.end]),
        ...sources.flatMap((x) => [x.start, x.end]),
      ].filter((n) => n >= start && n <= end),
    ),
  ].sort((a, b) => a - b);
  const idle: FlowIdle[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!,
      b = points[i + 1]!;
    if (a === b || busy.some((x) => x.start < b && x.end > a)) continue;
    const active = sources.filter((x) => x.start < b && x.end > a);
    const reason =
      (["owner", "quota", "check"] as const).find((r) => active.some((x) => x.reason === r)) ?? "gap";
    const evidenceSeqs = [...new Set(active.filter((x) => x.reason === reason).flatMap((x) => x.seqs))].sort(
      (x, y) => x - y,
    );
    const last = idle.at(-1);
    const finish = !endedAt && b === end ? null : new Date(b).toISOString();
    if (
      last &&
      last.endedAt === new Date(a).toISOString() &&
      last.reason === reason &&
      JSON.stringify(last.evidenceSeqs) === JSON.stringify(evidenceSeqs)
    )
      last.endedAt = finish;
    else idle.push({ startedAt: new Date(a).toISOString(), endedAt: finish, reason, evidenceSeqs });
  }
  return {
    startedAt: input.startedAt,
    endedAt,
    asOf,
    architect,
    tasks,
    dispatches,
    checks,
    causes,
    ownerWaits,
    quotaHolds,
    idle,
  };
}

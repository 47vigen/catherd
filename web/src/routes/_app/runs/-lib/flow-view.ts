import type { Attempt, FlowDispatch, RunFlow, RunModel, RunNode } from "../../../../client";

export function flowGeometry(flow: RunFlow, now: number) {
  const start = Date.parse(flow.startedAt);
  const end = Math.max(start, Date.parse(flow.endedAt ?? new Date(Math.max(now, Date.parse(flow.asOf))).toISOString()));
  const x = (at: string) => Math.max(0, (Date.parse(at) - start) / 500) + 16;
  return {
    end,
    width: Math.max(960, (end - start) / 500 + 80),
    nowX: x(new Date(end).toISOString()),
    x,
    interval: (startedAt: string, endedAt: string | null) => ({
      x: x(startedAt),
      width: Math.max(2, ((endedAt ? Date.parse(endedAt) : end) - Date.parse(startedAt)) / 500),
    }),
  };
}

/** Pack in source order; overlapping hit targets remain individually reachable. */
export function stackIntervals(intervals: { x: number; width: number }[]): number[] {
  const ends: number[] = [];
  return intervals.map(({ x, width }) => {
    let track = ends.findIndex((end) => end <= x);
    if (track < 0) track = ends.length;
    ends[track] = x + Math.max(28, width) + 4;
    return track;
  });
}

export const dispatchStatus = (d: FlowDispatch): RunNode["status"] =>
  d.status === "ok"
    ? "done"
    : d.status === "limit"
      ? "parked"
      : d.status === "running" || d.status === "cancelled"
        ? d.status
        : "failed";

function dispatchAttempt(d: FlowDispatch): Attempt {
  return {
    id: d.dispatchId,
    kind: "dispatch",
    label: d.name,
    round: null,
    status: dispatchStatus(d),
    at: d.startedAt,
    endedAt: d.endedAt,
    dispatchId: d.dispatchId,
    name: d.name,
    role: d.role,
    rung: d.rung,
    failoverFrom: null,
    judge: null,
    secs: d.endedAt ? (Date.parse(d.endedAt) - Date.parse(d.startedAt)) / 1000 : null,
    tokens: null,
    costUsd: d.costUsd,
    commit: null,
    exit: null,
    text: d.why,
  };
}

/** Drawer-only targets never change the graph, ledger or recorded provenance. */
export function drawerModel(model: RunModel): RunModel {
  if (!model.flow) return model;
  const nodes = [...model.nodes];
  for (const d of [...model.flow.architect, ...model.flow.dispatches]) {
    const existing = nodes.findIndex((n) => n.id === d.selection.nodeId);
    const attempt = dispatchAttempt(d);
    if (existing >= 0) {
      const n = nodes[existing]!;
      if (!n.attempts.some((a) => a.id === attempt.id)) nodes[existing] = { ...n, attempts: [attempt, ...n.attempts] };
      continue;
    }
    const role = ["architect", "verifier", "worker", "reviewer", "artist", "writer", "researcher"].includes(d.role)
      ? (d.role as RunNode["role"])
      : null;
    nodes.push({
      id: d.selection.nodeId,
      kind: d.role === "architect" ? "architect" : "lane",
      milestone: null,
      lane: null,
      role,
      title: d.name,
      status: dispatchStatus(d),
      now: d.why ?? d.status,
      rung: d.rung,
      startedAt: d.startedAt,
      endedAt: d.endedAt,
      question: null,
      attempts: [attempt],
    });
  }
  for (const c of model.flow.checks) {
    if (nodes.some((n) => n.id === c.selection.nodeId)) continue;
    nodes.push({
      id: c.selection.nodeId,
      kind: "check",
      milestone: null,
      lane: null,
      role: null,
      title: c.checkId,
      status: c.endedAt ? (c.exit === 0 ? "done" : "failed") : "running",
      now: c.why ?? c.command,
      rung: null,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      question: null,
      attempts: [],
    });
  }
  return { ...model, nodes };
}

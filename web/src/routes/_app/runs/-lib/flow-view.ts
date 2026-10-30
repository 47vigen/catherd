import type { Attempt, FlowDispatch, RunFlow, RunModel, RunNode } from "../../../../client";

export function flowGeometry(flow: RunFlow, now: number, viewport = 600, scale?: number) {
  const start = Date.parse(flow.startedAt);
  const end = Math.max(start, Date.parse(flow.endedAt ?? new Date(Math.max(now, Date.parse(flow.asOf))).toISOString()));
  const duration = Math.max(1, end - start);
  const pixelsPerMs = scale ?? Math.max(1, viewport - 32) / duration;
  const width = Math.max(viewport, duration * pixelsPerMs + 32);
  const x = (at: string) => Math.max(0, (Date.parse(at) - start) * pixelsPerMs) + 16;
  return {
    end,
    width,
    nowX: x(new Date(end).toISOString()),
    x,
    pixelsPerMs,
    interval: (startedAt: string, endedAt: string | null) => ({
      x: x(startedAt),
      width: Math.max(2, ((endedAt ? Date.parse(endedAt) : end) - Date.parse(startedAt)) * pixelsPerMs),
    }),
  };
}

export function tickStep(durationSeconds: number, width: number) {
  const target = durationSeconds / Math.max(1, width / 80);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000, 86400];
  return steps.find((step) => step >= target) ?? Math.ceil(target / 86400) * 86400;
}

export function mergeIdle(idle: RunFlow["idle"]) {
  const merged: RunFlow["idle"] = [];
  for (const item of idle) {
    const last = merged.at(-1);
    if (last && last.reason === item.reason && last.endedAt === item.startedAt) {
      last.endedAt = item.endedAt;
    } else merged.push({ ...item });
  }
  return merged;
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

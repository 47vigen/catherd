import type { Attempt, FlowCheck, FlowDispatch, FlowSelection, RunFlow, RunView } from "../../../../client";
import { mergeIdle } from "./flow-view";
import { formatCost, formatTokens, tokenTotal } from "./format";
import { formatDuration } from "./node-view";

export type FindingTone = "danger" | "warning" | "neutral";
export interface Finding {
  id: string;
  tone: FindingTone;
  title: string;
  detail: string | null;
  selection: FlowSelection | null;
}

/** Role families: the flow chart's colours, so a bar here and a bar there mean the same thing. */
export type Family = "architect" | "build" | "review" | "research" | "other";
export const familyOf = (role: string): Family =>
  role === "architect"
    ? "architect"
    : ["worker", "writer", "artist"].includes(role)
      ? "build"
      : ["reviewer", "verifier"].includes(role)
        ? "review"
        : role === "researcher"
          ? "research"
          : "other";
export const FAMILY_LABEL: Record<Family, string> = {
  architect: "Architect",
  build: "Worker, writer, artist",
  review: "Reviewer, verifier",
  research: "Researcher",
  other: "Other",
};

const ms = (from: string, to: string | null, end: number) =>
  Math.max(0, (to ? Date.parse(to) : end) - Date.parse(from));
const runEnd = (flow: RunFlow, now: number) =>
  flow.endedAt ? Date.parse(flow.endedAt) : Math.max(now, Date.parse(flow.asOf));
const BAD = new Set<FlowDispatch["status"]>(["failed", "timeout", "cli-too-old", "cancelled"]);
const pct = (share: number) => `${Math.round(share * 100)}%`;

export type TimeKey = "working" | "check" | "owner" | "quota" | "gap";
export const TIME_LABEL: Record<TimeKey, string> = {
  working: "Roles working",
  check: "Checks only",
  owner: "Waiting on you",
  quota: "Quota hold",
  gap: "Nothing running",
};

/** Where the wall time went: the flow's idle spans by reason, and the rest is time some role was working. */
export function timeSplit(flow: RunFlow, now: number): { wallMs: number; parts: { key: TimeKey; ms: number }[] } {
  const end = runEnd(flow, now);
  const wallMs = Math.max(0, end - Date.parse(flow.startedAt));
  const idle: Record<Exclude<TimeKey, "working">, number> = { check: 0, owner: 0, quota: 0, gap: 0 };
  for (const i of mergeIdle(flow.idle)) idle[i.reason] += ms(i.startedAt, i.endedAt, end);
  const idleMs = Object.values(idle).reduce((a, b) => a + b, 0);
  const parts = [
    { key: "working" as const, ms: Math.max(0, wallMs - idleMs) },
    ...(["check", "owner", "quota", "gap"] as const).map((key) => ({ key, ms: idle[key] })),
  ];
  // under a second rounds to "0s" and reads as noise
  return { wallMs, parts: parts.filter((p) => p.ms >= 1000) };
}

export interface Spend {
  dispatch: FlowDispatch;
  ms: number;
  tokens: number;
  cost: number | null;
}

/** Every role run of the flow (architect turns included) with what it used; tokens come from the model's attempts. */
export function spends(flow: RunFlow, attempts: readonly Attempt[], now: number): Spend[] {
  const end = runEnd(flow, now);
  const tokens = new Map(attempts.filter((a) => a.dispatchId).map((a) => [a.dispatchId!, tokenTotal(a.tokens)]));
  return [...flow.architect, ...flow.dispatches].map((d) => ({
    dispatch: d,
    ms: ms(d.startedAt, d.endedAt, end),
    tokens: tokens.get(d.dispatchId) ?? 0,
    cost: d.costUsd,
  }));
}

/**
 * Where the money went: by role family, and the role runs that used the most. Cost is the measure when every priced
 * role run has one; with no cost at all, tokens stand in, and `unit` says which.
 */
export function costSplit(all: readonly Spend[]) {
  const unit: "cost" | "tokens" = all.some((s) => s.cost != null) ? "cost" : "tokens";
  const value = (s: Spend) => (unit === "cost" ? (s.cost ?? 0) : s.tokens);
  const total = all.reduce((a, s) => a + value(s), 0);
  const byFamily = new Map<Family, number>();
  for (const s of all)
    byFamily.set(familyOf(s.dispatch.role), (byFamily.get(familyOf(s.dispatch.role)) ?? 0) + value(s));
  const families = [...byFamily.entries()]
    .map(([family, v]) => ({ family, value: v }))
    .filter((f) => f.value > 0)
    .sort((a, b) => b.value - a.value);
  const top = [...all]
    .filter((s) => value(s) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, 5)
    .map((s) => ({ spend: s, value: value(s) }));
  return { unit, total, families, top };
}

export const formatAmount = (unit: "cost" | "tokens", v: number) => (unit === "cost" ? formatCost(v) : formatTokens(v));

/** The last result of each check scope: a scope that failed and never passed again is still failing. */
function failingChecks(checks: readonly FlowCheck[]): FlowCheck[] {
  const last = new Map<string, FlowCheck>();
  for (const c of checks) {
    if (!c.endedAt) continue;
    const prev = last.get(c.scope);
    if (!prev || Date.parse(c.endedAt) >= Date.parse(prev.endedAt!)) last.set(c.scope, c);
  }
  return [...last.values()].filter((c) => c.exit !== 0 && c.verdict !== "inherited");
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const list = (names: string[]) =>
  names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");

/**
 * The few things a person would point at in this run, the most serious first. Each names what it is about and,
 * when there is one, the role run or check that shows it. Thresholds keep an ordinary run quiet.
 */
export function findings(run: RunView, flow: RunFlow, attempts: readonly Attempt[], now: number): Finding[] {
  const out: Finding[] = [];
  const ended = run.phase === "ended" || flow.endedAt !== null;
  const all = spends(flow, attempts, now);
  const roles = all.filter((s) => s.dispatch.role !== "architect");

  for (const c of failingChecks(flow.checks)) {
    const failures = c.newFailures ?? c.failureCount;
    out.push({
      id: `check-${c.checkId}`,
      tone: "danger",
      title:
        ended && run.outcome === "done"
          ? `The run ended done, but its last ${c.scope} check failed`
          : `The last ${c.scope} check failed`,
      detail: `${c.checkId} · exit ${c.exit ?? "?"}${failures ? ` · ${failures} failing` : ""} · ${c.command}`,
      selection: c.selection,
    });
  }

  const bad = roles.filter((s) => BAD.has(s.dispatch.status));
  if (bad.length === 1) {
    const d = bad[0]!.dispatch;
    out.push({
      id: "bad",
      tone: d.status === "cancelled" ? "warning" : "danger",
      title: `${d.name} ${d.status === "cancelled" ? "was cancelled" : d.status === "timeout" ? "timed out" : "failed"} after ${formatDuration(bad[0]!.ms / 1000)}`,
      detail: [d.role, d.rung, d.why].filter(Boolean).join(" · "),
      selection: d.selection,
    });
  } else if (bad.length > 1)
    out.push({
      id: "bad",
      tone: bad.some((s) => s.dispatch.status !== "cancelled") ? "danger" : "warning",
      title: `${bad.length} role runs did not finish`,
      detail: list(bad.map((s) => `${s.dispatch.name} (${s.dispatch.status})`)),
      selection: bad[0]!.dispatch.selection,
    });

  const limited = all.filter((s) => s.dispatch.status === "limit");
  const climbed = all.filter((s) => s.dispatch.climbFrom);
  if (limited.length || climbed.length)
    out.push({
      id: "limits",
      tone: "warning",
      title: [
        limited.length ? `${limited.length === 1 ? "1 role run" : `${limited.length} role runs`} hit a limit` : null,
        climbed.length ? `${climbed.length === 1 ? "1 retry" : `${climbed.length} retries`} on another rung` : null,
      ]
        .filter(Boolean)
        .join(", "),
      detail: list([...limited, ...climbed].map((s) => s.dispatch.name).filter((n, i, a) => a.indexOf(n) === i)),
      selection: (limited[0] ?? climbed[0])!.dispatch.selection,
    });

  const cost = costSplit(all);
  const lead = cost.top[0];
  if (lead && all.length >= 3 && cost.total > 0 && lead.value / cost.total >= 0.25)
    out.push({
      id: "spend",
      tone: "neutral",
      title: `${lead.spend.dispatch.name} took ${pct(lead.value / cost.total)} of the ${cost.unit === "cost" ? "cost" : "tokens"}`,
      detail: `${formatAmount(cost.unit, lead.value)} of ${formatAmount(cost.unit, cost.total)} · ${lead.spend.dispatch.role} · ${lead.spend.dispatch.rung}`,
      selection: lead.spend.dispatch.selection,
    });

  const finished = roles.filter((s) => s.dispatch.endedAt);
  const typical = median(finished.map((s) => s.ms));
  const longest = finished.toSorted((a, b) => b.ms - a.ms)[0];
  if (longest && finished.length >= 3 && typical > 0 && longest.ms >= 3 * typical && longest.ms >= 5 * 60_000)
    out.push({
      id: "long",
      tone: "neutral",
      title: `${longest.dispatch.name} ran ${formatDuration(longest.ms / 1000)}, ${Math.round(longest.ms / typical)}× the usual role run`,
      detail: `the median is ${formatDuration(typical / 1000)} · ${longest.dispatch.role} · ${longest.dispatch.rung}`,
      selection: longest.dispatch.selection,
    });

  const time = timeSplit(flow, now);
  const part = (key: TimeKey) => time.parts.find((p) => p.key === key)?.ms ?? 0;
  if (part("owner") >= 60_000) {
    const q = flow.ownerWaits.find((w) => w.question)?.question ?? null;
    out.push({
      id: "owner",
      tone: "neutral",
      title: `The run waited on you for ${formatDuration(part("owner") / 1000)}`,
      detail: q,
      selection: null,
    });
  }
  if (part("quota") >= 60_000)
    out.push({
      id: "quota",
      tone: "warning",
      title: `Quota held the run for ${formatDuration(part("quota") / 1000)}`,
      detail: [...new Set(flow.quotaHolds.map((h) => h.quota))].join(", ") || null,
      selection: null,
    });
  const idleMs = time.wallMs - part("working");
  if (time.wallMs > 0 && idleMs / time.wallMs >= 1 / 3) {
    const main = time.parts.filter((p) => p.key !== "working").toSorted((a, b) => b.ms - a.ms)[0];
    out.push({
      id: "idle",
      tone: "warning",
      title: `No role was working for ${pct(idleMs / time.wallMs)} of the run`,
      detail: main ? `mostly ${TIME_LABEL[main.key].toLowerCase()}: ${formatDuration(main.ms / 1000)}` : null,
      selection: null,
    });
  }

  const turns = all.filter((s) => s.dispatch.role === "architect");
  if (turns.length >= 3 && time.wallMs > 0) {
    const share = turns.reduce((a, s) => a + s.ms, 0) / time.wallMs;
    out.push({
      id: "architect",
      tone: "neutral",
      title: `The architect took ${turns.length} turns, ${pct(share)} of the wall time`,
      detail: `${roles.length} role ${roles.length === 1 ? "run" : "runs"} between them`,
      selection: turns.at(-1)!.dispatch.selection,
    });
  }

  if (ended) {
    const stuck = flow.tasks.filter((t) => t.state === "blocked" || t.state === "impossible");
    if (stuck.length)
      out.push({
        id: "stuck",
        tone: "warning",
        title: `${stuck.length === 1 ? "1 task" : `${stuck.length} tasks`} ended ${stuck.every((t) => t.state === "impossible") ? "impossible" : "blocked"}`,
        detail: list(stuck.map((t) => t.id)),
        selection: null,
      });
  }

  const rank: Record<FindingTone, number> = { danger: 0, warning: 1, neutral: 2 };
  return out.toSorted((a, b) => rank[a.tone] - rank[b.tone]);
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BudgetStatus, budgetStatus } from "../domain/budget.ts";
import { isCatherdError } from "../domain/errors.ts";
import type { Tokens } from "../domain/record.ts";
import { readJsonl } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { type DispatchState, liveDispatches } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import {
  findRun,
  listRuns,
  readAgentRuns,
  readRecords,
  readRoutes,
  type Run,
  runPaths,
} from "./run-store.ts";

export interface RunSummary {
  id: string;
  title: string;
  repo: string;
  createdAt: string;
  stateTail: string[];
  live: { name: string; rung: string; state: DispatchState; secs: number; dispatchId: string }[];
  totals: { runs: number; ok: number; notOk: string[]; tokens: Tokens; costUsd: number; wallMinutes: number };
  /** native subagent runs, as the orchestrator reported them: reported, not measured (spec §14) */
  agents: { runs: number; totalTokens: number; costUsd: number };
  jev: { decisions: number; fallbacks: number };
  budget: BudgetStatus | null;
  milestones: string[];
  warnings: string[];
}

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
    : [];

/** One run at a glance. Spec §3.4: reads are pure; nothing here finalizes a dispatch or writes a file. */
export function summarizeRun(deps: Deps, run: Run): RunSummary {
  const now = deps.now();
  const { records, corrupt } = readRecords(run);
  const live = liveDispatches(run, now);
  const agents = readAgentRuns(run);
  const jev = readJsonl<{ source?: string }>(runPaths(run.dir).jev).rows;
  const sum = (f: (t: Tokens) => number) => records.reduce((n, r) => n + f(r.tokens), 0);
  let budget: BudgetStatus | null = null;
  const warnings = corrupt ? [`runs.jsonl: skipped ${corrupt} unreadable row(s)`] : [];
  try {
    budget = budgetStatus(spendOf(run, records, live, now), deps.profiles.forRepo(run.meta.repo).budget);
  } catch (e) {
    warnings.push(`budget: ${isCatherdError(e) ? e.message : String(e)}`);
  }
  return {
    id: run.id,
    title: run.meta.title,
    repo: run.meta.repo,
    createdAt: run.meta.createdAt,
    stateTail: lines(runPaths(run.dir).state).slice(-3),
    live: live.map((d) => ({
      name: d.admit.name,
      rung: d.admit.rung,
      state: d.state,
      secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
      dispatchId: d.admit.dispatchId,
    })),
    totals: {
      runs: records.length,
      ok: records.filter((r) => r.status === "ok").length,
      notOk: records.filter((r) => r.status !== "ok").map((r) => `${r.name} (${r.status})`),
      tokens: { input: sum((t) => t.input), cached: sum((t) => t.cached), output: sum((t) => t.output) },
      costUsd: records.reduce((n, r) => n + (r.costUsd ?? 0), 0),
      wallMinutes: Math.round((now - Date.parse(run.meta.createdAt)) / 60_000),
    },
    agents: {
      runs: agents.length,
      totalTokens: agents.reduce((n, a) => n + a.totalTokens, 0),
      costUsd: agents.reduce((n, a) => n + (a.costUsd ?? 0), 0),
    },
    jev: { decisions: jev.length, fallbacks: jev.filter((j) => j.source === "default").length },
    budget,
    milestones: lines(runPaths(run.dir).ledger).slice(1),
    warnings,
  };
}

/** `status(run?)`: that run; without one, every run with a live role, else the newest run. */
export function status(
  deps: Deps,
  runId?: string,
): { version: string; runs: RunSummary[]; warnings: string[] } {
  if (runId) return { version: deps.version, runs: [summarizeRun(deps, findRun(runId))], warnings: [] };
  const { runs, corrupt } = listRuns();
  const warnings = corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`);
  const all = runs.map((r) => summarizeRun(deps, r));
  const live = all.filter((s) => s.live.length > 0);
  return { version: deps.version, runs: live.length ? live : all.slice(0, 1), warnings };
}

export interface RungStats {
  role: string;
  rung: string;
  runs: number;
  ok: number;
  refusals: number;
  climbsFrom: number;
  secs: number;
  tokens: Tokens;
}

export interface HarnessCost {
  backend: string;
  nativeRuns: number;
  isolatedRuns: number;
  nativeMedian: number | null;
  isolatedMedian: number | null;
  extraPerRun: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

/** What the user's own harness setup costs per run: median first-turn input, native against isolated. */
export function harnessCosts(runs: Run[]): HarnessCost[] {
  type Row = { backend: string; isolated: boolean; firstTurnInput: number };
  const rows = runs.flatMap((r) => readJsonl<Row>(runPaths(r.dir).harness).rows);
  return [...new Set(rows.map((r) => r.backend))].sort().map((backend) => {
    const pick = (isolated: boolean) =>
      rows.filter((r) => r.backend === backend && r.isolated === isolated).map((r) => r.firstTurnInput);
    const native = median(pick(false));
    const isolated = median(pick(true));
    return {
      backend,
      nativeRuns: pick(false).length,
      isolatedRuns: pick(true).length,
      nativeMedian: native,
      isolatedMedian: isolated,
      extraPerRun: native !== null && isolated !== null ? native - isolated : null,
    };
  });
}

/** Per role and rung over past runs: runs, ok, refusals, climbs from it, seconds and tokens. Reads only. */
export function runsSummary(f: { run?: string; repo?: string; role?: string; sinceDays?: number }): {
  rungs: RungStats[];
  agents: { rung: string; runs: number; totalTokens: number; secs: number }[];
  harness: HarnessCost[];
} {
  const since = f.sinceDays ? Date.now() - f.sinceDays * 86_400_000 : 0;
  const repo = f.repo ? resolve(f.repo) : null;
  const runs = listRuns().runs.filter(
    (r) =>
      (!f.run || r.id === f.run) && (!repo || r.meta.repo === repo) && Date.parse(r.meta.createdAt) >= since,
  );
  const stats = new Map<string, RungStats>();
  const at = (role: string, rung: string): RungStats => {
    const key = `${role} ${rung}`;
    let s = stats.get(key);
    if (!s) {
      s = {
        role,
        rung,
        runs: 0,
        ok: 0,
        refusals: 0,
        climbsFrom: 0,
        secs: 0,
        tokens: { input: 0, cached: 0, output: 0 },
      };
      stats.set(key, s);
    }
    return s;
  };
  const agents = new Map<string, { rung: string; runs: number; totalTokens: number; secs: number }>();
  for (const run of runs) {
    for (const r of readRecords(run).records) {
      if (f.role && r.role !== f.role) continue;
      const s = at(r.role, r.rung);
      s.runs++;
      if (r.status === "ok") s.ok++;
      if (r.replyStatus === "refused" || r.replyStatus === "blocked") s.refusals++;
      s.secs += r.secs;
      s.tokens.input += r.tokens.input;
      s.tokens.cached += r.tokens.cached;
      s.tokens.output += r.tokens.output;
    }
    for (const c of readRoutes(run))
      if (c.source === "climb" && c.from && (!f.role || c.role === f.role)) at(c.role, c.from).climbsFrom++;
    for (const a of readAgentRuns(run)) {
      if (f.role && a.role !== f.role) continue;
      const s = agents.get(a.rung) ?? { rung: a.rung, runs: 0, totalTokens: 0, secs: 0 };
      s.runs++;
      s.totalTokens += a.totalTokens;
      s.secs += a.secs ?? 0;
      agents.set(a.rung, s);
    }
  }
  return {
    rungs: [...stats.values()].sort((a, b) => a.role.localeCompare(b.role) || a.rung.localeCompare(b.rung)),
    agents: [...agents.values()].sort((a, b) => a.rung.localeCompare(b.rung)),
    harness: harnessCosts(runs),
  };
}

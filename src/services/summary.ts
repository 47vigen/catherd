import { resolve } from "node:path";
import { type BudgetStatus, budgetStatus } from "../domain/budget.ts";
import { isCatherdError } from "../domain/errors.ts";
import type { Tokens } from "../domain/record.ts";
import { median } from "../domain/util.ts";
import { nonBlankLines, readJsonl } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
import { type DispatchState, liveDispatches } from "./dispatches.ts";
import { type RunSession, sessionFacts } from "./session-view.ts";
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
  /** spec §4: the Claude Code session that started it (null before 1.1), named live while it runs */
  session: RunSession | null;
  /** the session that continued it, when another did */
  continuedIn: string | null;
  stateTail: string[];
  live: { name: string; rung: string; state: DispatchState; secs: number; dispatchId: string }[];
  totals: { runs: number; ok: number; notOk: string[]; tokens: Tokens; costUsd: number; wallMinutes: number };
  /** native subagent runs, as the orchestrator reported them: reported, not measured (spec §14) */
  agents: { runs: number; totalTokens: number; costUsd: number };
  jev: { decisions: number; fallbacks: number };
  /** per backend, how many of this run's dispatches ran with the user's harness (native) and isolated */
  harness: { backend: string; native: number; isolated: number }[];
  budget: BudgetStatus | null;
  milestones: string[];
  /** spec 1.1 §7: the verifier's latest gate_check, so the user sees where it is */
  verifier: VerifierStep | null;
  warnings: string[];
}

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
    ...sessionFacts(run),
    stateTail: nonBlankLines(runPaths(run.dir).state).slice(-3),
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
    // a jev-kind, lane or default source is a decision Jev did not make whole
    jev: { decisions: jev.length, fallbacks: jev.filter((j) => j.source !== "jev").length },
    harness: [...new Set(records.map((r) => r.backend))].sort().map((backend) => {
      const of = records.filter((r) => r.backend === backend);
      return {
        backend,
        native: of.filter((r) => !r.isolated).length,
        isolated: of.filter((r) => r.isolated).length,
      };
    }),
    budget,
    milestones: nonBlankLines(runPaths(run.dir).ledger).slice(1),
    verifier: latestVerifierStep(run),
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

/** A median in whole tokens: an even count's mean of the two middle values is rounded. */
function tokenMedian(xs: number[]): number | null {
  const m = median(xs);
  return m === null ? null : Math.round(m);
}

/** Fewer first-turn samples than this on either side, and the harness line gives no figure. */
const HARNESS_MIN_RUNS = 3;

/**
 * What the user's own harness setup costs per run: median first-turn input, native against isolated.
 * No figure below HARNESS_MIN_RUNS a side, nor when native is not dearer: noise, not a cost.
 */
function harnessCosts(runs: Run[]): HarnessCost[] {
  type Row = { backend: string; isolated: boolean; firstTurnInput: number };
  const rows = runs.flatMap((r) => readJsonl<Row>(runPaths(r.dir).harness).rows);
  return [...new Set(rows.map((r) => r.backend))].sort().map((backend) => {
    const pick = (isolated: boolean) =>
      rows.filter((r) => r.backend === backend && r.isolated === isolated).map((r) => r.firstTurnInput);
    const nativeRuns = pick(false).length;
    const isolatedRuns = pick(true).length;
    const native = tokenMedian(pick(false));
    const isolated = tokenMedian(pick(true));
    const enough = nativeRuns >= HARNESS_MIN_RUNS && isolatedRuns >= HARNESS_MIN_RUNS;
    const extra = native !== null && isolated !== null ? native - isolated : 0;
    return {
      backend,
      nativeRuns,
      isolatedRuns,
      nativeMedian: native,
      isolatedMedian: isolated,
      extraPerRun: enough && extra > 0 ? extra : null,
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
  const all = listRuns().runs.filter(
    (r) => (!repo || r.meta.repo === repo) && Date.parse(r.meta.createdAt) >= since,
  );
  const runs = all.filter((r) => !f.run || r.id === f.run);
  // with a run given, the harness line compares like with like: every run of that run's repo
  const harnessRepo = f.run ? runs[0]?.meta.repo : undefined;
  const harnessRuns = f.run ? all.filter((r) => r.meta.repo === harnessRepo) : runs;
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
    harness: harnessCosts(harnessRuns),
  };
}

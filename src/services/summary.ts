import type { HostContext } from "../domain/host.ts";
import type { QueueCapability } from "../infra/codex-queue.ts";
import { inspectionHost, inspectDeliveries, type DeliveryInspection } from "./run-debug.ts";
import { type BudgetStatus, budgetStatus } from "../domain/budget.ts";
import { errorMessage, isCatherdError } from "../domain/errors.ts";
import type { RunRecord, Tokens } from "../domain/record.ts";
import type { QuotaRow } from "../domain/scorecard.ts";
import { coveredMs } from "../domain/util.ts";
import { db } from "../infra/db.ts";
import { nonBlankLines, readJsonl } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { ensureDaemon } from "./daemon.ts";
import { type Pause, pauseSpans, pausesOver } from "./pause.ts";
import { pinChanges, runProfile } from "./run-pin.ts";
import { type OpenQuestion, openQuestions } from "./questions.ts";
import { type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { readDelivery, ROLE_THREAD_REFUSAL } from "../infra/delivery.ts";
import { type RunSession, sessionFacts } from "./session-view.ts";
import { isDaemonRun, readEvents, replayRun } from "./run-events-store.ts";
import type { Deps } from "./ports.ts";
import { orchestratorWait, type OrchestratorWait } from "./orchestrator-wait.ts";
import {
  findRun,
  listRuns,
  readAgentRuns,
  readRecords,
  type Run,
  runPaths,
  supersededBy,
} from "./run-store.ts";

export interface RunSummary {
  /** No live roles and at least one durable completion the orchestrator has not collected. */
  waiting?: OrchestratorWait | null;
  delivery: (DeliveryInspection & { name: string; dispatchId: string })[];
  id: string;
  /** spec 1.5 "runs supersede": the run that took this one over; status() without a run hides it */
  supersededBy?: string | null;
  /** spec 1.5: what changed since the run's pin; dispatch keeps the pinned values */
  pinChanges?: string[];
  /** spec 1.1 §8: the owner questions not answered yet, listed first */
  questions: OpenQuestion[];
  title: string;
  repo: string;
  createdAt: string;
  /** spec §4: the Claude Code session that started it (null before 1.1), named live while it runs */
  session: RunSession | null;
  /** the session that continued it, when another did */
  continuedIn: string | null;
  stateTail: string[];
  /** the run's `run.ended`: its outcome and when; state.md still says what came next, so the tail drops that */
  ended?: { at: string; outcome: string } | null;
  live: { name: string; rung: string; state: DispatchState; secs: number; dispatchId: string }[];
  totals: {
    runs: number;
    ok: number;
    notOk: string[];
    tokens: Tokens;
    costUsd: number | null;
    unpriced: number;
    wallMinutes: number;
  };
  /** native subagent runs, as the orchestrator reported them: reported, not measured (spec §14) */
  agents: { runs: number; totalTokens: number; costUsd: number };
  /** decisions.jsonl rows that name a source (`decide` rows), counted by it: model, floor, failover, coordinator */
  decisions: Record<string, number>;
  /** per backend, how many of this run's dispatches ran with the user's harness (native) and isolated */
  harness: { backend: string; native: number; isolated: number }[];
  budget: BudgetStatus | null;
  milestones: string[];
  warnings: string[];
}

/** Plan 52: an architect run's last check, from the checks table (its state.md is the 1.5 orchestrator's). */
function lastCheckLine(run: Run): string {
  const c = db()
    .query(
      "SELECT check_id, scope, base, exit, failures FROM checks WHERE run_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(run.id) as {
    check_id: string;
    scope: string;
    base: number;
    exit: number | null;
    failures: string;
  } | null;
  if (!c) return "Last check: none yet";
  const what = `${c.check_id} (${c.scope}${c.base ? ", on the base" : ""})`;
  if (c.exit === 0) return `Last check: ${what} passed`;
  const failing = (JSON.parse(c.failures) as string[]).length;
  return `Last check: ${what} ${c.exit === null ? "timed out" : `failed (exit ${c.exit})`}: ${failing} failing line(s)`;
}

/** One run at a glance. Spec §3.4: reads are pure; nothing here finalizes a dispatch or writes a file. */
export function summarizeRun(deps: Deps, run: Run): RunSummary {
  const now = deps.now();
  const warnings: string[] = [];
  // an unfinished 2.0 run whose daemon died gets it back from any reader: status, watch, the panel
  try {
    ensureDaemon(run);
  } catch (e) {
    warnings.push(`daemon: ${errorMessage(e)}`);
  }
  const { records, corrupt } = readRecords(run);
  let ended: RunSummary["ended"] = null;
  try {
    const e = readEvents(run).find((x) => x.type === "run.ended");
    if (e?.type === "run.ended") ended = { at: e.at, outcome: e.outcome };
  } catch (e) {
    warnings.push(`events: ${errorMessage(e)}`);
  }
  const questions = ended
    ? []
    : isDaemonRun(run)
      ? Object.values(replayRun(run).questions).map((q) => ({
          milestone: q.unit,
          question: q.question,
          at: q.at,
        }))
      : openQuestions(run);
  const live = liveDispatches(run, now);
  // an ended run's clock stops at run.ended: its wall minutes and its minute budget
  const until = ended ? Date.parse(ended.at) : now;
  const start = Date.parse(run.meta.createdAt);
  const recorded = new Set(records.map((r) => r.dispatchId));
  const agents = readAgentRuns(run);
  const decisions: Record<string, number> = {};
  for (const d of readJsonl<{ source?: string }>(runPaths(run.dir).decisionsLog).rows)
    if (d.source) decisions[d.source] = (decisions[d.source] ?? 0) + 1;
  const priced = records.map((r) => r.costUsd).filter((cost) => cost !== null);
  const sum = (f: (t: Tokens) => number) => records.reduce((n, r) => n + f(r.tokens), 0);
  let budget: BudgetStatus | null = null;
  if (corrupt) warnings.push(`runs.jsonl: skipped ${corrupt} unreadable row(s)`);
  // spec 1.5 "Pinned per run": a change since the pin, which dispatch does not follow
  const pinned = pinChanges(deps, run);
  for (const c of pinned) warnings.push(`pinned: ${c}; dispatch keeps the pinned value (run_pin re-pins)`);
  try {
    budget = budgetStatus(spendOf(run, records, live, until), runProfile(deps, run).budget);
  } catch (e) {
    warnings.push(`budget: ${isCatherdError(e) ? e.message : String(e)}`);
  }
  // spec 1.5 plan 21: a notice refused because its target was a role's thread, while that is its latest attempt
  for (const d of listDispatches(run)) {
    try {
      const last = readDelivery(d.dir).at(-1);
      if (last?.status === "failed" && last.reason?.startsWith(ROLE_THREAD_REFUSAL))
        warnings.push(`${d.admit.name}: its notice was not sent: ${last.reason}`);
    } catch {
      // unreadable delivery evidence is the delivery row's to show
    }
  }
  return {
    waiting: orchestratorWait(run, now, records, live.length > 0),
    delivery: listDispatches(run).flatMap((d) =>
      inspectDeliveries(run, d, recorded.has(d.admit.dispatchId)).map((inspection) => ({
        name: d.admit.name,
        dispatchId: d.admit.dispatchId,
        ...inspection,
      })),
    ),
    id: run.id,
    supersededBy: supersededBy(run)?.by ?? null,
    pinChanges: pinned,
    questions,
    title: run.meta.title,
    repo: run.meta.repo,
    createdAt: run.meta.createdAt,
    ...sessionFacts(run),
    ended,
    stateTail: isDaemonRun(run)
      ? [lastCheckLine(run)]
      : nonBlankLines(runPaths(run.dir).state)
          .filter((l) => !ended || !/^(Next|Protocol next): /.test(l))
          .slice(-3),
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
      tokens: {
        input: sum((t) => t.input),
        cached: sum((t) => t.cached),
        cacheWrite: sum((t) => t.cacheWrite ?? 0),
        output: sum((t) => t.output),
      },
      costUsd: priced.length ? priced.reduce((n, cost) => n + cost, 0) : null,
      unpriced: records.length - priced.length,
      wallMinutes: Math.round(Math.max(0, until - start - coveredMs(start, until, pauseSpans(run))) / 60_000),
    },
    agents: {
      runs: agents.length,
      totalTokens: agents.reduce((n, a) => n + a.totalTokens, 0),
      costUsd: agents.reduce((n, a) => n + (a.costUsd ?? 0), 0),
    },
    decisions,
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
    warnings,
  };
}

/**
 * `status(run?)`: that run; without one, the live runs, else the runs waiting for their orchestrator (a current
 * owner, a recent unread record: plan 22), else the newest run.
 */
export function status(
  deps: Deps,
  runId?: string,
  queue: QueueCapability | null = null,
): {
  /** spec 1.5 "Group pause": the machine's pause and the listed runs' workspace pauses, shown first */
  paused: Pause[];
  version: string;
  runs: RunSummary[];
  warnings: string[];
  host: HostContext;
  queue: QueueCapability | null;
} {
  if (runId) {
    const run = findRun(runId);
    return {
      paused: pausesOver([run]),
      host: inspectionHost(deps.host),
      queue,
      version: deps.version,
      runs: [summarizeRun(deps, run)],
      warnings: [],
    };
  }
  const { runs: listed, corrupt } = listRuns();
  const warnings = corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`);
  // a superseded run is closed: only status(run) shows it
  const runs = listed.filter((r) => !supersededBy(r));
  const all = runs.map((r) => summarizeRun(deps, r));
  const live = all.filter((s) => s.live.length > 0);
  const waiting = all.filter((s) => s.waiting);
  const shown = live.length ? live : waiting.length ? waiting : all.slice(0, 1);
  return {
    paused: pausesOver(runs.filter((r) => shown.some((s) => s.id === r.id))),
    host: inspectionHost(deps.host),
    queue,
    version: deps.version,
    runs: shown,
    warnings,
  };
}

/** Plan 28: tokens and usage limits per backend over `records`, sorted by backend. */
export function quotaByBackend(records: RunRecord[]): QuotaRow[] {
  const by = new Map<string, QuotaRow>();
  for (const r of records) {
    const q = by.get(r.backend) ?? { backend: r.backend, runs: 0, input: 0, cached: 0, output: 0, limits: 0 };
    q.runs++;
    q.input += r.tokens.input;
    q.cached += r.tokens.cached;
    q.output += r.tokens.output;
    if (r.status === "limit") q.limits++;
    by.set(r.backend, q);
  }
  return [...by.values()].sort((a, b) => a.backend.localeCompare(b.backend));
}

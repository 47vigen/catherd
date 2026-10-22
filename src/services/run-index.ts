import { statSync } from "node:fs";
import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import { tryParseRung } from "../domain/ids.ts";
import { isDone, liveDispatches, replay } from "../domain/run-state.ts";
import { log } from "../infra/log.ts";
import { landedMilestones } from "./milestones.ts";
import type { Deps } from "./ports.ts";
import { openQuestions } from "./questions.ts";
import { eventsFile, isDaemonRun, readEvents } from "./run-events-store.ts";
import { listRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";
import { interventionsOf, runEnd } from "./scorecard-metrics.ts";

/**
 * The run index (panel v2): one summary per run on the machine, read from the run's own files and kept in memory
 * only. A run is recomputed when the mtime and size of its `events.jsonl` or `runs.jsonl` change.
 */
export const RunCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  engine: z.enum(["2.0", "1.5"]),
  phase: z.enum(["planning", "approval", "running", "ended"]).nullable(),
  outcome: z.enum(["done", "cancelled", "failed"]).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** null while the run is live (the page counts from startedAt) */
  wallMinutes: z.number().nullable(),
  milestones: z.object({ total: z.number().int(), landed: z.number().int() }),
  live: z.array(z.object({ name: z.string(), role: z.string(), rung: z.string(), unit: z.string() })),
  openQuestions: z.number().int(),
  totals: z.object({
    dispatches: z.number().int(),
    tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }),
    costUsd: z.number(),
    interventions: z.number().int(),
    failovers: z.number().int(),
    climbs: z.number().int(),
    rounds: z.number().int(),
  }),
  byBackend: z.array(z.object({ backend: z.string(), tokens: z.number(), costUsd: z.number() })),
  /** model = "<backend>:<model>" */
  byModel: z.array(z.object({ model: z.string(), tokens: z.number() })),
  byRole: z.array(z.object({ role: z.string(), secs: z.number() })),
});
export type RunCard = z.infer<typeof RunCardSchema>;

/** `mtimeMs:size`, `0:0` when the file is missing. */
function stamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "0:0";
  }
}

const cache = new Map<string, { key: string; card: RunCard }>();

/** `computed` counts recomputations, so a test can tell a cache hit from a read. */
export const runIndexCache = {
  computed: 0,
  clear(): void {
    cache.clear();
  },
};

/** Adds `n` to `key`'s entry of `m`, in insertion order. */
const bump = (m: Map<string, number>, key: string, n: number): void => void m.set(key, (m.get(key) ?? 0) + n);

function compute(deps: Deps, run: Run): RunCard {
  const { records } = readRecords(run);
  const daemon = isDaemonRun(run);
  const events = daemon ? readEvents(run) : [];
  const state = daemon ? replay(events, run.id) : null;
  const ended = events.findLast((e) => e.type === "run.ended");
  const endMs = state ? (state.phase === "ended" ? Date.parse(ended?.at ?? state.at) : null) : runEnd(run);
  const startedAt = run.meta.createdAt;

  const tokens = { input: 0, cached: 0, output: 0 };
  const backends = new Map<string, { tokens: number; costUsd: number }>();
  const models = new Map<string, number>();
  const roles = new Map<string, number>();
  let costUsd = 0;
  for (const r of records) {
    tokens.input += r.tokens.input;
    tokens.cached += r.tokens.cached;
    tokens.output += r.tokens.output;
    const t = r.tokens.input + r.tokens.output;
    const c = r.costUsd ?? 0;
    costUsd += c;
    const b = backends.get(r.backend) ?? { tokens: 0, costUsd: 0 };
    backends.set(r.backend, { tokens: b.tokens + t, costUsd: b.costUsd + c });
    bump(models, `${r.backend}:${tryParseRung(r.rung)?.model ?? r.rung}`, t);
    bump(roles, r.role, r.secs);
  }

  return {
    id: run.id,
    title: run.meta.title,
    repo: run.meta.repo,
    engine: state ? "2.0" : "1.5",
    phase: state?.phase ?? null,
    outcome: state?.outcome ?? null,
    startedAt,
    endedAt: endMs === null ? null : new Date(endMs).toISOString(),
    wallMinutes: endMs === null ? null : Math.max(0, (endMs - Date.parse(startedAt)) / 60_000),
    milestones: state
      ? { total: state.milestones.length, landed: state.milestones.filter(isDone).length }
      : { total: landedMilestones(run).length, landed: landedMilestones(run).length },
    live: state
      ? liveDispatches(state).map((d) => ({ name: d.name, role: d.role, rung: d.rung, unit: d.unit }))
      : [],
    openQuestions: state ? Object.keys(state.questions).length : openQuestions(run).length,
    totals: {
      dispatches: records.length,
      tokens,
      costUsd,
      // shortcut: superseded counts refresh with the run's own files only, upgrade if the scorecard needs them live
      interventions: interventionsOf(run, endMs ?? deps.now(), 0).total,
      failovers: records.filter((r) => r.failoverFrom !== null).length,
      climbs: readRoutes(run).filter((r) => r.source === "climb").length,
      rounds: state ? state.milestones.reduce((n, m) => n + m.round, 0) : 0,
    },
    byBackend: [...backends].map(([backend, v]) => ({ backend, ...v })),
    byModel: [...models].map(([model, t]) => ({ model, tokens: t })),
    byRole: [...roles].map(([role, secs]) => ({ role, secs })),
  };
}

/** Every repo's runs (one repo's with `repo`), newest first. A run whose files cannot be read is logged and left out. */
export function runIndex(deps: Deps, o: { repo?: string } = {}): RunCard[] {
  const out: RunCard[] = [];
  for (const run of listRuns(o.repo ? [o.repo] : undefined).runs) {
    try {
      const key = `${stamp(eventsFile(run))}|${stamp(runPaths(run.dir).runs)}`;
      const hit = cache.get(run.dir);
      if (hit?.key === key) {
        out.push(hit.card);
        continue;
      }
      runIndexCache.computed++;
      const card = compute(deps, run);
      cache.set(run.dir, { key, card });
      out.push(card);
    } catch (e) {
      cache.delete(run.dir);
      log("warn", "index", { run: run.id, error: errorMessage(e) });
    }
  }
  return out;
}

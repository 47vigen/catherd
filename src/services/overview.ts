import { z } from "zod";
import { median } from "../domain/util.ts";
import type { Deps } from "./ports.ts";
import { type RunCard, RunCardSchema, runIndex } from "./run-index.ts";
import { ParkedViewSchema, parkedQuestions } from "./run-read.ts";

/** The dashboard's numbers for a range of start dates (panel v2, section B), from the run index. */
export const NowLineSchema = z.object({
  node: z.string(),
  title: z.string(),
  text: z.string(),
  rung: z.string().nullable(),
});
export type NowLine = z.infer<typeof NowLineSchema>;

export const OverviewSchema = z.object({
  from: z.string(),
  to: z.string(),
  repo: z.string().nullable(),
  repos: z.array(z.string()),
  kpis: z.object({
    runs: z.number().int(),
    ended: z.number().int(),
    clean: z.number().int(),
    cleanPct: z.number().nullable(),
    medianWallMinutes: z.number().nullable(),
    interventions: z.number().int(),
    costUsd: z.number(),
    tokens: z.number(),
  }),
  daily: z.array(
    z.object({
      day: z.string(),
      backends: z.array(z.object({ backend: z.string(), tokens: z.number(), costUsd: z.number() })),
    }),
  ),
  tokensByModel: z.array(z.object({ model: z.string(), tokens: z.number() })),
  secsByRole: z.array(z.object({ role: z.string(), secs: z.number() })),
  failovers: z.number().int(),
  climbs: z.number().int(),
  live: z.array(z.object({ run: RunCardSchema, now: z.array(NowLineSchema) })),
  questions: z.object({ total: z.number().int(), first: z.array(ParkedViewSchema) }),
  recent: z.array(RunCardSchema),
});
export type Overview = z.infer<typeof OverviewSchema>;

const DAY = 86_400_000;
const MAX_DAYS = 366;
const MODELS_SHOWN = 8;

/** Sums `[key, n]` pairs per key, largest first. */
function sumBy<K extends string>(pairs: Iterable<[K, number]>): [K, number][] {
  const m = new Map<K, number>();
  for (const [k, n] of pairs) m.set(k, (m.get(k) ?? 0) + n);
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function overview(
  deps: Deps,
  q: { from: number; to: number; repo?: string },
  nowOf: (runId: string) => NowLine[] = () => [],
): Overview {
  const from = Math.max(q.from, q.to - MAX_DAYS * DAY);
  const all = runIndex(deps);
  const scoped = q.repo ? all.filter((r) => r.repo === q.repo) : all;
  const inRange = scoped.filter((r) => {
    const t = Date.parse(r.startedAt);
    return t >= from && t <= q.to;
  });
  const ended = inRange.filter((r) => r.endedAt !== null);
  const clean = ended.filter((r) => r.outcome === "done" && r.totals.interventions === 0);
  const sum = (f: (r: RunCard) => number): number => inRange.reduce((n, r) => n + f(r), 0);

  const daily = new Map<string, Map<string, { tokens: number; costUsd: number }>>();
  for (let t = Math.floor(from / DAY) * DAY; t <= q.to; t += DAY)
    daily.set(new Date(t).toISOString().slice(0, 10), new Map());
  for (const r of inRange) {
    const day = daily.get(r.startedAt.slice(0, 10));
    for (const b of r.byBackend) {
      const cur = day?.get(b.backend) ?? { tokens: 0, costUsd: 0 };
      day?.set(b.backend, { tokens: cur.tokens + b.tokens, costUsd: cur.costUsd + b.costUsd });
    }
  }

  const byModel = sumBy(inRange.flatMap((r) => r.byModel.map((m): [string, number] => [m.model, m.tokens])));
  const tokensByModel = byModel.slice(0, MODELS_SHOWN).map(([model, tokens]) => ({ model, tokens }));
  if (byModel.length > MODELS_SHOWN)
    tokensByModel.push({
      model: "other",
      tokens: byModel.slice(MODELS_SHOWN).reduce((n, [, t]) => n + t, 0),
    });

  const ids = new Set(scoped.map((r) => r.id));
  const parked = parkedQuestions().filter((p) => ids.has(p.run));

  return {
    from: new Date(from).toISOString(),
    to: new Date(q.to).toISOString(),
    repo: q.repo ?? null,
    repos: [...new Set(all.map((r) => r.repo))],
    kpis: {
      runs: inRange.length,
      ended: ended.length,
      clean: clean.length,
      cleanPct: ended.length ? (clean.length / ended.length) * 100 : null,
      medianWallMinutes: median(ended.flatMap((r) => (r.wallMinutes === null ? [] : [r.wallMinutes]))),
      interventions: sum((r) => r.totals.interventions),
      costUsd: sum((r) => r.totals.costUsd),
      tokens: sum((r) => r.totals.tokens.input + r.totals.tokens.output),
    },
    daily: [...daily].map(([day, m]) => ({
      day,
      backends: [...m]
        .map(([backend, v]) => ({ backend, ...v }))
        .sort((a, b) => a.backend.localeCompare(b.backend)),
    })),
    tokensByModel,
    secsByRole: sumBy(inRange.flatMap((r) => r.byRole.map((x): [string, number] => [x.role, x.secs]))).map(
      ([role, secs]) => ({ role, secs }),
    ),
    failovers: sum((r) => r.totals.failovers),
    climbs: sum((r) => r.totals.climbs),
    live: scoped
      .filter((r) => r.engine === "2.0" && r.phase !== "ended")
      .map((run) => ({ run, now: nowOf(run.id) })),
    questions: { total: parked.length, first: parked.slice(0, 5) },
    recent: inRange.slice(0, 10),
  };
}

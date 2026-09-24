import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role, RungId, Tokens } from "../types.ts";
import { formatHarness, type HarnessCost, harnessCosts } from "./harness.ts";
import { readRoutes } from "./lanes.ts";
import { reconcileLive } from "./reconcile.ts";
import { listRuns, readJsonl, readRunRecords, type Run } from "./runstore.ts";

export interface RunSummary {
  id: string;
  title: string;
  repo: string;
  stateTail: string[];
  live: { name: string; rung: RungId; secs: number; pid: number }[];
  totals: { runs: number; ok: number; notOk: string[]; secs: number; tokens: Tokens; costUsd: number };
  jev: { decisions: number; fallbacks: number };
  milestones: string[];
  harness: HarnessCost[];
}

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
    : [];

export function summarizeRun(run: Run): RunSummary {
  const { stillRunning } = reconcileLive(run.dir);
  const recs = readRunRecords(run.dir);
  const jev = readJsonl<{ source?: string }>(join(run.dir, "jev.jsonl"));
  const now = Date.now();
  return {
    id: run.id,
    title: run.meta.title,
    repo: run.meta.repo,
    stateTail: lines(join(run.dir, "state.md")).slice(-3),
    live: stillRunning.map((m) => ({
      name: m.name,
      rung: m.rung,
      secs: Math.round((now - Date.parse(m.startedAt)) / 1000),
      pid: m.pid,
    })),
    totals: {
      runs: recs.length,
      ok: recs.filter((r) => r.status === "ok").length,
      notOk: recs.filter((r) => r.status !== "ok").map((r) => `${r.name} (${r.status})`),
      secs: recs.reduce((n, r) => n + r.secs, 0),
      tokens: {
        input: recs.reduce((n, r) => n + r.tokens.input, 0),
        cached: recs.reduce((n, r) => n + r.tokens.cached, 0),
        output: recs.reduce((n, r) => n + r.tokens.output, 0),
      },
      costUsd: recs.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    },
    jev: { decisions: jev.length, fallbacks: jev.filter((j) => j.source === "default").length },
    milestones: lines(join(run.dir, "ledger.md")).slice(1),
    harness: harnessCosts(listRuns().map((r) => r.dir)),
  };
}

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function formatSummary(s: RunSummary): string {
  const t = s.totals;
  return [
    `== ${s.title} · ${s.id}`,
    ...s.stateTail,
    "-- running",
    ...(s.live.length ? s.live.map((l) => `  ${l.name}  ${l.rung}  ${mmss(l.secs)}`) : ["  none"]),
    `-- done  ${t.runs} runs · ${t.ok} ok · ${Math.round(t.secs / 60)} min · ${t.tokens.input} in / ${t.tokens.output} out tokens · $${t.costUsd.toFixed(2)}${t.notOk.length ? ` · not ok: ${t.notOk.join(", ")}` : ""}`,
    `-- jev  ${s.jev.decisions} decisions · ${s.jev.fallbacks} fell back to default`,
    ...(s.harness.length
      ? s.harness.map((h) => `-- harness  ${formatHarness(h)}`)
      : ["-- harness  no data yet"]),
    ...(s.milestones.length ? ["-- landed", ...s.milestones.map((m) => `  ${m}`)] : []),
  ].join("\n");
}

export interface RungStats {
  role: Role;
  rung: RungId;
  runs: number;
  ok: number;
  refusals: number;
  climbsFrom: number;
  secs: number;
  tokens: Tokens;
}

export function runsSummary(
  f: { run?: string; repo?: string; role?: Role; sinceDays?: number } = {},
): RungStats[] {
  const since = f.sinceDays ? Date.now() - f.sinceDays * 86_400_000 : 0;
  const runs = listRuns().filter(
    (r) =>
      (!f.run || r.id === f.run) &&
      (!f.repo || r.meta.repo === f.repo) &&
      Date.parse(r.meta.createdAt) >= since,
  );
  const stats = new Map<string, RungStats>();
  const at = (role: Role, rung: RungId): RungStats => {
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
  for (const run of runs) {
    for (const r of readRunRecords(run.dir)) {
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
    for (const c of readRoutes(run.dir)) {
      if (c.source !== "climb" || !c.from || (f.role && c.role !== f.role)) continue;
      at(c.role, c.from).climbsFrom++;
    }
  }
  return [...stats.values()].sort((a, b) => a.role.localeCompare(b.role) || a.rung.localeCompare(b.rung));
}

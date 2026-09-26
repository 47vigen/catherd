import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeProfileName, loadProfile } from "../profile/profile.ts";
import type { Profile, Role, RungId, Tokens } from "../types.ts";
import { formatHarness, type HarnessCost, harnessCosts } from "./harness.ts";
import { readRoutes } from "./lanes.ts";
import { reconcileLive } from "./reconcile.ts";
import { listRuns, readJsonl, readRunRecords, type Run } from "./runstore.ts";

export type RunTotals = {
  runs: number;
  ok: number;
  notOk: string[];
  secs: number;
  tokens: Tokens;
  costUsd: number;
};

export interface RunSummary {
  id: string;
  title: string;
  repo: string;
  stateTail: string[];
  live: { name: string; rung: RungId; secs: number; pid: number }[];
  totals: RunTotals;
  jev: { decisions: number; fallbacks: number };
  milestones: string[];
  harness: HarnessCost[];
  /** spec §11b: this run's spend against the active profile's budget, or null with no budget set */
  budget: BudgetStatus | null;
}

export interface BudgetStatus {
  /** the highest spent/cap ratio across the caps the profile set; ≥ 1 means exhausted */
  fraction: number;
  minutes?: { spent: number; cap: number };
  tokens?: { spent: number; cap: number };
  usd?: { spent: number; cap: number };
}

export function budgetStatus(totals: RunTotals, budget: Profile["budget"] | undefined): BudgetStatus | null {
  if (!budget) return null;
  const b: BudgetStatus = { fraction: 0 };
  const consider = (spent: number, cap: number | undefined, key: "minutes" | "tokens" | "usd") => {
    if (cap === undefined) return;
    b[key] = { spent, cap };
    b.fraction = Math.max(b.fraction, cap > 0 ? spent / cap : spent > 0 ? 1 : 0);
  };
  consider(totals.secs / 60, budget.minutes, "minutes");
  consider(totals.tokens.input + totals.tokens.output, budget.tokens, "tokens");
  consider(totals.costUsd, budget.usd, "usd");
  return b;
}

export function formatBudget(b: BudgetStatus): string {
  const parts: string[] = [];
  if (b.minutes) parts.push(`${Math.round(b.minutes.spent)}/${b.minutes.cap} min`);
  if (b.tokens) parts.push(`${b.tokens.spent}/${b.tokens.cap} tokens`);
  if (b.usd) parts.push(`$${b.usd.spent.toFixed(2)}/$${b.usd.cap.toFixed(2)}`);
  return `${parts.join(" · ")} (${Math.round(b.fraction * 100)}%)`;
}

/** The active profile's budget for this run's repo, or undefined when there is none or the profile fails to load. */
function budgetFor(run: Run): Profile["budget"] | undefined {
  try {
    return loadProfile(activeProfileName(run.meta.repo)).budget;
  } catch {
    return undefined;
  }
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
  // a 1.0 jev.jsonl opens with a `{schema, kind}` header row, which is not a decision
  const jev = readJsonl<{ source?: string; schema?: unknown; kind?: unknown }>(
    join(run.dir, "jev.jsonl"),
  ).filter((j) => !(typeof j.schema === "number" && typeof j.kind === "string" && j.source === undefined));
  const now = Date.now();
  const totals: RunTotals = {
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
  };
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
    totals,
    jev: { decisions: jev.length, fallbacks: jev.filter((j) => j.source === "default").length },
    milestones: lines(join(run.dir, "ledger.md")).slice(1),
    harness: harnessCosts(listRuns().map((r) => r.dir)),
    budget: budgetStatus(totals, budgetFor(run)),
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
    ...(s.budget ? [`-- budget  ${formatBudget(s.budget)}`] : []),
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

import type { Overview, RunCard } from "../../../client";
import { backendName } from "../../../components/provider-icon/ProviderIcon";
import type { Status } from "../../../components/status-chip/StatusChip";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** The request range: `days` whole UTC days ending with `today` (YYYY-MM-DD), so the key changes once a day. */
export function rangeOf(days: number, today: string): { from: string; to: string } {
  const end = Date.parse(`${today}T23:59:59.999Z`);
  return { from: new Date(end + 1 - days * DAY).toISOString(), to: new Date(end).toISOString() };
}

/** Time since a start: "45s", "12m 04s", "2h 05m", "3d 4h". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  if (s < DAY / 1000) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

const compact = (n: number, unit: string) => `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)}${unit}`;

/** Token counts and other big numbers: "812", "34k", "1.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return n < 1_000_000 ? compact(n / 1000, "k") : compact(n / 1_000_000, "M");
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const formatCost = (usd: number): string => money.format(usd);

/** Wall minutes: "–" when unknown, "42 min", "1.6 h". */
export function formatMinutes(min: number | null): string {
  if (min === null) return "–";
  if (min < 1) return "<1 min";
  return min < 60 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1)} h`;
}

/** Worked seconds: "40s", "12m", "1h 20m". */
export function formatSecs(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** The folder name of a repo path; the full path goes in a tooltip. */
export const repoName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** What a run is doing: a 1.5 run is only informational, an outcome ends the story, a question comes next. */
export function runStatus(r: RunCard): Status {
  if (r.engine === "1.5") return "info";
  if (r.outcome) return r.outcome;
  if (r.openQuestions > 0) return "parked";
  return r.phase === "planning" || r.phase === "approval" ? r.phase : "running";
}

export type Metric = "cost" | "tokens";

const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fullDay = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export type DailyRow = { day: string; label: string; total: number; values: Record<string, number> };

/** One column per day; backends that share a display name ("opencode", "opencode-go") are one series. */
export function dailyRows(
  daily: Overview["daily"],
  metric: Metric,
  days: number,
): { keys: string[]; rows: DailyRow[] } {
  const label = days <= 7 ? weekday : monthDay;
  const keys: string[] = [];
  const rows = daily.map((d) => {
    const values: Record<string, number> = {};
    for (const b of d.backends) {
      const key = backendName(b.backend);
      if (!keys.includes(key)) keys.push(key);
      values[key] = (values[key] ?? 0) + (metric === "cost" ? b.costUsd : b.tokens);
    }
    const at = new Date(`${d.day}T00:00:00Z`);
    return {
      day: fullDay.format(at),
      label: label.format(at),
      total: Object.values(values).reduce((a, b) => a + b, 0),
      values,
    };
  });
  return { keys, rows };
}

/** Per-day totals of one metric, for a sparkline. */
export const dailyTotals = (daily: Overview["daily"], metric: Metric): number[] =>
  daily.map((d) => d.backends.reduce((n, b) => n + (metric === "cost" ? b.costUsd : b.tokens), 0));

const TONE: Record<string, number> = { Codex: 0, Cursor: 1, opencode: 2, "Claude Code": 4, Claude: 4 };
const FILL = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;
const BG = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

/** One colour per backend on every chart of the page, so Codex reads the same in the plot and the lists. */
export function backendTone(backendOrName: string): { fill: string; bg: string } {
  const i = TONE[backendName(backendOrName)] ?? 3;
  return { fill: FILL[i]!, bg: BG[i]! };
}

const UPPER = new Set(["gpt", "glm"]);

/** A model as people say it: "codex:gpt-6-luna#high" is "GPT-6 Luna", "claude-opus-5-5" is "Claude Opus 5.5". */
export function modelName(rung: string): string {
  const id =
    rung
      .replace(/^[^:]*:/, "")
      .replace(/#.*$/, "")
      .split("/")
      .pop() ?? rung;
  const out: string[] = [];
  // A dated snapshot suffix ("-20250929") is noise in a label.
  for (const part of id.split("-").filter((p) => p && !/^\d{6,}$/.test(p))) {
    const prev = out.at(-1);
    if (/^\d{1,2}$/.test(part) && prev && /\d$/.test(prev)) out[out.length - 1] = `${prev}.${part}`;
    else if (/^[\d.]+$/.test(part) && prev === "GPT") out[out.length - 1] = `GPT-${part}`;
    else if (UPPER.has(part.toLowerCase())) out.push(part.toUpperCase());
    else out.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(" ") || rung;
}

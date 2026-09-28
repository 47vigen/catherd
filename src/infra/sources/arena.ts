import { effortWord } from "../../domain/sources.ts";
import { type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: the Agent Arena boards and WebDev (CC-BY-4.0). */
export const ARENA_CONFIGS = [
  "agent",
  "agent_task_outcome_explicit",
  "agent_bash_recovery_steps",
  "agent_steerability",
  "agent_tool_hallucination",
  "webdev",
] as const;
export type ArenaConfig = (typeof ARENA_CONFIGS)[number];

export const ARENA_PAGE = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";

export const arenaUrl = (config: ArenaConfig): string =>
  `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=${config}&split=latest&length=100`;

/** Every config, in parallel; one failure fails the source, which keeps its last answer. */
export async function fetchArena(t: SourceTransport = {}): Promise<Record<ArenaConfig, unknown>> {
  const got = await Promise.all(
    ARENA_CONFIGS.map(async (c) => [c, (await sourceGet(arenaUrl(c), t)).json()]),
  );
  return Object.fromEntries(got) as Record<ArenaConfig, unknown>;
}

/**
 * Spec 1.2 §3.4: an Arena model name as `<name>#<effort>`: the effort from a `(Max)`/`(xHigh)`/`(High)`
 * suffix, or from a trailing `-max`/`-xhigh`/`-high` (WebDev's ids). A harness note such as
 * `(codex-harness)` is dropped; any other parenthesis stays part of the name.
 */
export function arenaRung(name: string): string {
  let rest = name.replace(/\s*\([^()]*harness\)/gi, "").trim();
  let effort: string | null = null;
  rest = rest
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
      const e = effort === null ? effortWord(inner) : null;
      if (e === null) return whole;
      effort = e;
      return "";
    })
    .trim();
  if (effort === null) {
    const m = /^(.*)-([A-Za-z]+)$/.exec(rest);
    const e = m ? effortWord(m[2] as string) : null;
    if (m && e) {
      effort = e;
      rest = m[1] as string;
    }
  }
  return effort === null ? rest : `${rest}#${effort}`;
}

interface ArenaRow {
  model_name?: unknown;
  score?: unknown;
  rating?: unknown;
  leaderboard_publish_date?: unknown;
}

/**
 * One row per model and config: `field` is the config, `value` the agent boards' `score` (net improvement) or
 * WebDev's `rating`, dated by the board's publish date.
 */
export function parseArena(raw: Record<string, unknown>, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const config of ARENA_CONFIGS) {
    const list = (raw[config] as { rows?: { row?: ArenaRow }[] } | undefined)?.rows;
    if (!Array.isArray(list)) continue;
    for (const { row } of list) {
      if (!row || typeof row.model_name !== "string") continue;
      const value = num(config === "webdev" ? row.rating : row.score);
      if (value === null) continue;
      const published = typeof row.leaderboard_publish_date === "string" ? row.leaderboard_publish_date : "";
      rows.push({
        rung: arenaRung(row.model_name),
        field: config,
        value,
        date: /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : isoDay(fetchedAt),
        url: ARENA_PAGE,
      });
    }
  }
  return rows;
}

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRanLines } from "../domain/ran-lines.ts";
import type { RunRecord } from "../domain/record.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import type { Run } from "./run-store.ts";

/** One row of the run report's `## Scorecard` (plan 44 B16). */
export interface RoleScore {
  role: Role;
  dispatches: number;
  /** of the dispatches whose brief.md is on disk; 0 when none is */
  briefBytes: { median: number; max: number };
  inputTokens: number;
  /** cached / input, 0 for no input */
  cacheHit: number;
  wallSecs: number;
  /** median dispatches per lane; null for a role with no lane */
  roundsPerLane: number | null;
  /** by `dispatch.ended.reason`, and `limit`, `failed`, `timeout` by status */
  stops: Record<string, number>;
  /** median RAN lines per verifier reply; null for other roles */
  verifierRan: number | null;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const STOP_STATUSES = new Set(["limit", "failed", "timeout"]);

/** Per role, in `ROLES` order, what the run's dispatches did; a role with no dispatch is left out. */
export function roleScorecard(run: Run, events: RunEvent[], records: RunRecord[]): RoleScore[] {
  const roleOf = new Map(records.map((r) => [r.dispatchId, r.role]));
  for (const e of events) if (e.type === "dispatch.started") roleOf.set(e.dispatchId, e.role);
  const stopsOf = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (e.type !== "dispatch.ended") continue;
    const role = roleOf.get(e.dispatchId);
    const stops = role ? (stopsOf.get(role) ?? {}) : null;
    if (!role || !stops) continue;
    for (const why of [e.reason, STOP_STATUSES.has(e.status) ? e.status : null])
      if (why) stops[why] = (stops[why] ?? 0) + 1;
    stopsOf.set(role, stops);
  }
  const read = (file: string): string | null => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  return ROLES.flatMap((role) => {
    const mine = records.filter((r) => r.role === role);
    if (mine.length === 0) return [];
    const sizes: number[] = [];
    const ran: number[] = [];
    const perLane = new Map<string, number>();
    for (const r of mine) {
      if (r.lane) perLane.set(r.lane, (perLane.get(r.lane) ?? 0) + 1);
      if (!r.replyPath) continue;
      const folder = join(run.dir, dirname(r.replyPath));
      try {
        sizes.push(statSync(join(folder, "brief.md")).size);
      } catch {
        // a dispatch with no brief file is skipped
      }
      if (role === "verifier") ran.push(parseRanLines(read(join(run.dir, r.replyPath)) ?? "").length);
    }
    const input = mine.reduce((n, r) => n + r.tokens.input, 0);
    const cached = mine.reduce((n, r) => n + r.tokens.cached, 0);
    return [
      {
        role,
        dispatches: mine.length,
        briefBytes: { median: median(sizes), max: Math.max(0, ...sizes) },
        inputTokens: input,
        cacheHit: input > 0 ? cached / input : 0,
        wallSecs: mine.reduce((n, r) => n + r.secs, 0),
        roundsPerLane: perLane.size ? median([...perLane.values()]) : null,
        stops: stopsOf.get(role) ?? {},
        verifierRan: role === "verifier" ? median(ran) : null,
      },
    ];
  });
}

/** The `## Scorecard` section: a table, one row per role that dispatched. */
export function scorecardLines(card: RoleScore[]): string[] {
  const cell = (n: number | null): string => (n === null ? "-" : String(Math.round(n * 10) / 10));
  return [
    "## Scorecard",
    "",
    "| role | dispatches | brief bytes (median / max) | input tokens | cache hit | wall secs | rounds per lane | stops | RAN lines per verifier reply |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...card.map(
      (s) =>
        `| ${s.role} | ${s.dispatches} | ${s.briefBytes.median} / ${s.briefBytes.max} | ${s.inputTokens} | ${Math.round(s.cacheHit * 100)} % | ${s.wallSecs} | ${cell(s.roundsPerLane)} | ${
          Object.entries(s.stops)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ") || "-"
        } | ${cell(s.verifierRan)} |`,
    ),
    "",
  ];
}

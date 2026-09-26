import { join } from "node:path";
import { readJsonl } from "../core/runstore.ts";
import type { RunSummary } from "../core/status.ts";
import type { RunRecord, RungId } from "../types.ts";
import { climbLine, clock, face, glyph, type Mood, shortRung } from "./theme.ts";

/**
 * The fields `watch` shows from one `jev.jsonl` row. A 1.0 row (services/jev-service.ts JevRow) names
 * the `call` and `questionSet` it asked and carries its `answers` keyed by question; a 0.x row listed
 * its `questions`. Both carry the answer actually used and whether Jev answered or a fallback did.
 */
export interface JevLine {
  questions?: string[];
  call?: string;
  questionSet?: string;
  answers?: Record<string, unknown> | null;
  used: string;
  source: string;
}

/** 1.0 jsonl files open with a `{schema, kind}` header row, which is not a decision. */
export const isJsonlHeader = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { schema?: unknown }).schema === "number" &&
  typeof (v as { kind?: unknown }).kind === "string" &&
  !("used" in v);

/** The decisions in a run's jev.jsonl, header skipped, 0.x and 1.0 rows alike. */
export function readJev(dir: string): JevLine[] {
  return readJsonl<unknown>(join(dir, "jev.jsonl")).filter(
    (r): r is JevLine => typeof r === "object" && r !== null && !isJsonlHeader(r),
  );
}

export function runMood(s: RunSummary): Mood {
  if (s.live.length > 0) return "working";
  if (s.totals.notOk.length > 0) return "failed";
  return s.totals.runs > 0 ? "good" : "waiting";
}

export function runLine(s: RunSummary, plain: boolean): string {
  return [
    `${face(runMood(s), plain)} ${s.title}`,
    `${s.live.length} live`,
    `${s.totals.runs} runs`,
    `${s.milestones.length} landed`,
  ].join(` ${glyph("dot", plain)} `);
}

export function liveLine(l: RunSummary["live"][number], plain: boolean): string {
  return `${glyph("cat", plain)} ${l.name}  ${shortRung(l.rung)}  ${clock(l.secs)}  ${face("working", plain)}`;
}

export function milestoneLine(m: string, plain: boolean): string {
  const id = /\bM\d+\b/.exec(m)?.[0];
  if (!id) return `${face("landed", plain)} ${m}`;
  const mins = /\b(\d+)m\b/.exec(m)?.[1];
  const sha = /\b[0-9a-f]{7,40}\b/.exec(m)?.[0]?.slice(0, 7);
  return [`${face("landed", plain)} ${id} landed`, mins ? `${mins}m` : null, sha ?? null]
    .filter((x): x is string => x !== null)
    .join(` ${glyph("dot", plain)} `);
}

/** Remembers each role's last rung across polls; a role that comes back on another rung has climbed. */
export function climbs(seen: Map<string, RungId>, s: RunSummary, plain: boolean): string[] {
  const out: string[] = [];
  for (const l of s.live) {
    const key = `${s.id}/${l.name}`;
    const from = seen.get(key);
    if (from !== undefined && from !== l.rung) out.push(climbLine(l.name, from, l.rung, plain));
    seen.set(key, l.rung);
  }
  return out;
}

export function recordLine(r: RunRecord, plain: boolean): string {
  const tail = r.replyStatus ? ` ${glyph("dot", plain)} ${r.replyStatus}` : "";
  return `${r.name}  ${shortRung(r.rung)}  ${r.status}  ${clock(r.secs)}${tail}`;
}

export function jevLine(e: JevLine, plain: boolean): string {
  const tail = e.source === "default" ? ` ${glyph("dot", plain)} fell back to the profile default` : "";
  const arrow = glyph("arrow", plain);
  if (e.call !== undefined) {
    const asked = Object.keys(e.answers ?? {});
    const head = [`${e.call} ${e.questionSet ?? "?"}`, ...(asked.length > 0 ? [asked.join(", ")] : [])];
    return `${head.join(` ${glyph("dot", plain)} `)} ${arrow} ${e.used}${tail}`;
  }
  return `${(e.questions ?? []).join(", ")} ${arrow} ${e.used}${tail}`;
}

/** spec §11b: --plain's stand-in for the coloured budget bar, e.g. "[#####-----] 52%". */
export function plainBudgetBar(fraction: number, width = 10): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.round(f * 100)}%`;
}

/** spec §11b: the bar is the ginger-to-pink gradient below 80%, a solid warning tint from 80%,
 * and a solid error tint once the budget is spent. Only ginger/pink exist in the warm palette
 * (theme.ts), so "warning" and "error" reuse them rather than adding new tones. */
export type BudgetTone = "gradient" | "warning" | "error";

export function budgetTone(fraction: number): BudgetTone {
  if (fraction >= 1) return "error";
  if (fraction >= 0.8) return "warning";
  return "gradient";
}

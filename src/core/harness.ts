import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "../types.ts";
import { appendJsonl, readJsonl, rolePaths } from "./runstore.ts";

export interface HarnessRow {
  at: string;
  name: string;
  backend: "codex" | "opencode";
  isolated: boolean;
  firstTurnInput: number;
}

export interface HarnessCost {
  backend: "codex" | "opencode";
  nativeRuns: number;
  isolatedRuns: number;
  nativeMedian: number | null;
  isolatedMedian: number | null;
  extraPerRun: number | null;
}

export function firstTurnInput(jsonlFile: string): number | null {
  if (!existsSync(jsonlFile)) return null;
  for (const line of readFileSync(jsonlFile, "utf8").split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      return (JSON.parse(line) as { usage?: { input_tokens?: number } }).usage?.input_tokens ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function recordHarness(runDir: string, r: RunRecord): void {
  const n = firstTurnInput(rolePaths(runDir, r.name).jsonl);
  // ponytail: opencode's stream has no token usage, so only Codex runs feed the estimate
  if (n === null) return;
  const row: HarnessRow = {
    at: new Date().toISOString(),
    name: r.name,
    backend: r.backend,
    isolated: r.isolated,
    firstTurnInput: n,
  };
  appendJsonl(join(runDir, "harness.jsonl"), row);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

export function harnessCosts(runDirs: string[]): HarnessCost[] {
  const rows = runDirs.flatMap((d) => readJsonl<HarnessRow>(join(d, "harness.jsonl")));
  return (["codex", "opencode"] as const).flatMap((backend) => {
    const native = rows.filter((r) => r.backend === backend && !r.isolated).map((r) => r.firstTurnInput);
    const isolated = rows.filter((r) => r.backend === backend && r.isolated).map((r) => r.firstTurnInput);
    if (native.length === 0 && isolated.length === 0) return [];
    const n = median(native);
    const i = median(isolated);
    return [
      {
        backend,
        nativeRuns: native.length,
        isolatedRuns: isolated.length,
        nativeMedian: n,
        isolatedMedian: i,
        extraPerRun: n !== null && i !== null ? n - i : null,
      },
    ];
  });
}

const k = (n: number) => `~${Math.round(n / 1000)}k`;
const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

export function formatHarness(h: HarnessCost): string {
  if (h.extraPerRun !== null && h.nativeMedian !== null && h.isolatedMedian !== null) {
    return `your ${h.backend} customizations add ${k(h.extraPerRun)} input tokens per run (first turn: native ${k(h.nativeMedian)} over ${runs(h.nativeRuns)}, isolated ${k(h.isolatedMedian)} over ${runs(h.isolatedRuns)})`;
  }
  const native = h.nativeMedian !== null;
  const med = (native ? h.nativeMedian : h.isolatedMedian) as number;
  const n = native ? h.nativeRuns : h.isolatedRuns;
  return `${h.backend} ${native ? "native" : "isolated"}: median first-turn input ${k(med)} tokens over ${runs(n)}; no ${native ? "isolated" : "native"} runs to compare`;
}

import type { RunRecord } from "./record.ts";

/** Spec §4.4: what the orchestrator does next, read off one finished record. `dir` is the dispatch folder, relative to the run. */
export function dispatchHints(r: RunRecord, owns: string[], dir: string): string[] {
  const h: string[] = [];
  if (r.status === "limit") h.push(`limit: ${r.backend} hit a usage limit on ${r.rung}`);
  if (r.status === "cli-too-old") h.push(`cli-too-old: ${r.error?.message ?? `upgrade ${r.backend}`}`);
  if (r.status === "failed") h.push(`failed: read ${dir}/stderr`);
  if (r.replyStatus === "refused" || r.replyStatus === "blocked") h.push(`climb: ${r.replyStatus}`);
  else if (r.status === "ok" && owns.length > 0 && r.changedOwned.length === 0) h.push("climb: unchanged");
  if (r.violations.length > 0) h.push(`violation: ${r.violations.join(", ")}`);
  if (r.threadHeavy) h.push("thread-heavy");
  return h;
}

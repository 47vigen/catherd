import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeDecision } from "../domain/judge.ts";
import type { RunEvent } from "../domain/run-events.ts";
import type { RunState } from "../domain/run-state.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { readRecords, type Run } from "./run-store.ts";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

/** What a judge decided, in one line: the verb's own payload. */
function said(d: JudgeDecision): string {
  switch (d.verb) {
    case "route":
      return d.routes.map((r) => `${r.finding} -> ${r.to}`).join(", ");
    case "answer":
      return d.answer;
    case "ask_owner":
    case "park":
      return d.question;
    default:
      return d.why;
  }
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

/**
 * `<run>/report.md`, the body of the merge request: the run's title, each landed milestone's digest, the known
 * issues verbatim by milestone, and the audit: every judge decision, and what each milestone's check passed on
 * only through the base or a rerun (`audits`). Returns its path.
 */
export function writeRunReport(
  run: Run,
  s: RunState,
  events: RunEvent[],
  audits: Record<string, string[]> = {},
): string {
  const landed = events.filter((e) => e.type === "milestone.landed");
  const decided = events.filter((e) => e.type === "judge.decided");
  const lines = [`# ${s.title || run.meta.title}`, ""];
  for (const e of landed) {
    const title = s.milestones.find((m) => m.id === e.milestone)?.title;
    const digest = read(e.digestPath.startsWith("/") ? e.digestPath : join(run.dir, e.digestPath));
    lines.push(
      `## ${e.milestone}${title && title !== e.milestone ? `: ${title}` : ""}`,
      "",
      digest || `Landed at ${e.commit.slice(0, 12)}.`,
      "",
    );
  }
  if (landed.length === 0) lines.push("No milestone landed.", "");
  lines.push("## Known issues", "");
  const issues = landed.flatMap((e) => e.knownIssues.map((k) => `- ${e.milestone}: ${k}`));
  lines.push(...(issues.length ? issues : ["None."]), "", "## Audit", "");
  const audit = [
    ...decided.map((e) => `- ${e.unit} (${e.kind}): ${e.decision.verb}: ${oneLine(said(e.decision))}`),
    ...Object.entries(audits).flatMap(([m, lines]) => lines.map((l) => `- ${m} (check): ${oneLine(l)}`)),
    // a worker's conflict with its plan task, in record order
    ...readRecords(run).records.flatMap((r) =>
      (r.design ?? []).map((d) => `- ${r.name} DESIGN: ${oneLine(d)}`),
    ),
  ];
  lines.push(...(audit.length ? audit : ["No judge decision."]), "");
  const file = join(run.dir, "report.md");
  writeTextAtomic(file, lines.join("\n"));
  return file;
}

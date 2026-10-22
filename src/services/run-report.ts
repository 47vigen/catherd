import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeDecision, RuleChange } from "../domain/judge.ts";
import { type Finding, issueLine, type RunEvent } from "../domain/run-events.ts";
import { findingKey, type RunState } from "../domain/run-state.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { readChecks } from "./milestone-check.ts";
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
    case "rules":
      return `${d.changes.length} change(s) proposed`;
    default:
      return d.why;
  }
}

const quote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * The `## Rules review` section (plan 34): what the finished run's judge proposed, each change followed by the
 * command that applies it. The run applies none; null when the run had no review (cancelled, failed).
 */
function rulesSection(failed: boolean, proposals: RuleChange[] | undefined): string[] | null {
  if (failed) return ["## Rules review", "", "No rules review: the judge gave no readable answer.", ""];
  if (!proposals) return null;
  if (proposals.length === 0)
    return ["## Rules review", "", "The judge proposed no change to the standing rules.", ""];
  return [
    "## Rules review",
    "",
    "Standing rules to review: apply any of these with the command under it.",
    ...proposals.flatMap((c, i) => [
      `${i + 1}. ${c.op === "add" ? "ADD" : "REMOVE"} ${c.text}${c.why ? ` — ${c.why}` : ""}`,
      `   \`catherd knowledge ${c.op === "add" ? "add" : "rm"} ${quote(c.text)}\``,
    ]),
    "",
  ];
}

/** The "fixed" part of a milestone's `Rounds:` line shows at most this many findings. */
export const FIXED_LINES = 15;

/**
 * The findings of each review round of milestone `m`: a `commit.made` opens a round, and every ok reviewer end
 * (`reviewer`, `ui-reviewer`, the partial pass `reviewer-<M>-2`) adds to it. A round with no reviewer end is left out.
 */
export function reviewRounds(events: RunEvent[], m: string): Finding[][] {
  const reviewers = new Set<string>();
  const rounds: Finding[][] = [];
  let open: Finding[] | null = null;
  for (const e of events) {
    if (e.type === "dispatch.started") {
      if ((e.role === "reviewer" || e.role === "ui-reviewer") && e.unit === m) reviewers.add(e.dispatchId);
    } else if (e.type === "commit.made" && e.milestone === m) open = null;
    else if (
      e.type === "dispatch.ended" &&
      reviewers.has(e.dispatchId) &&
      e.status === "ok" &&
      e.replyStatus !== "blocked" &&
      e.replyStatus !== "refused"
    ) {
      if (!open) rounds.push((open = []));
      open.push(...e.findings);
    }
  }
  return rounds;
}

/** `Rounds: 3 review round(s) · fixed: <the BLOCKER and BUG lines an earlier round named and the last did not repeat>`. */
export function roundsLine(events: RunEvent[], m: string): string {
  const rounds = reviewRounds(events, m);
  const last = new Set((rounds.at(-1) ?? []).map((f) => findingKey(issueLine(f))));
  const seen = new Set<string>();
  const fixed: string[] = [];
  for (const f of rounds.slice(0, -1).flat()) {
    const key = findingKey(issueLine(f));
    if (f.label === "NIT" || last.has(key) || seen.has(key)) continue;
    seen.add(key);
    fixed.push(issueLine(f));
  }
  const head = `Rounds: ${rounds.length} review round(s)`;
  return fixed.length ? `${head} · fixed: ${fixed.slice(0, FIXED_LINES).join(" · ")}` : head;
}

/** Per command, the latest check record of this run and milestone that is no baseline; "Gate: not recorded" when none. */
export function gateLines(run: Run, m: string): string[] {
  const latest = new Map<string, ReturnType<typeof readChecks>[number]>();
  try {
    for (const r of readChecks(run.meta.repo))
      if (r.run === run.id && r.milestone === m && !r.baseline) latest.set(r.command, r);
  } catch {
    // a check store that cannot be read records nothing
  }
  return latest.size
    ? [...latest.values()].map(
        (r) =>
          `Gate: \`${r.command}\` exit ${r.exit} on ${r.head.slice(0, 12)} · ${Math.round(r.durationMs / 1000)} s · secret scan: ${r.secrets ?? "not run"}`,
      )
    : ["Gate: not recorded"];
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
  proposals?: RuleChange[],
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
      // the section heading above is the digest's own H1
      digest.replace(/^# .*\n+/, "") || `Landed at ${e.commit.slice(0, 12)}.`,
      "",
      roundsLine(events, e.milestone),
      ...gateLines(run, e.milestone),
      "",
    );
  }
  if (landed.length === 0) lines.push("No milestone landed.", "");
  lines.push("## Known issues", "");
  const issues = landed.flatMap((e) => e.knownIssues.map((k) => `- ${e.milestone}: ${k}`));
  lines.push(...(issues.length ? issues : ["None."]), "");
  // plan 34: the latest lint of each milestone's preflight
  const lint = [
    ...new Set(events.flatMap((e) => (e.type === "preflight.done" ? [e.milestone] : []))),
  ].flatMap((m) => {
    const latest = events.findLast((e) => e.type === "preflight.done" && e.milestone === m);
    return latest?.type === "preflight.done" ? latest.lint.map((l) => `- ${m}: ${l}`) : [];
  });
  if (lint.length) lines.push("## Plan lint", "", ...lint, "");
  lines.push("## Audit", "");
  const audit = [
    ...decided.map((e) => `- ${e.unit} (${e.kind}): ${e.decision.verb}: ${oneLine(said(e.decision))}`),
    ...Object.entries(audits).flatMap(([m, lines]) => lines.map((l) => `- ${m} (check): ${oneLine(l)}`)),
    // a worker's conflict with its plan task, in record order
    ...readRecords(run).records.flatMap((r) =>
      (r.design ?? []).map((d) => `- ${r.name} DESIGN: ${oneLine(d)}`),
    ),
  ];
  lines.push(...(audit.length ? audit : ["No judge decision."]), "");
  lines.push(...(rulesSection(s.rulesReview?.failed === true, proposals) ?? []));
  const file = join(run.dir, "report.md");
  writeTextAtomic(file, lines.join("\n"));
  return file;
}

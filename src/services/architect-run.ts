import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ArchTask,
  isStanding,
  lastReview,
  STANDING_CAP,
  taskAttempts,
  WRITER_CAP,
} from "../domain/architect-state.ts";
import type { BriefParts } from "../domain/brief.ts";
import { ledgerView } from "../domain/ledger.ts";
import { planInputNames } from "../domain/plan-doc.ts";
import { lintPlan } from "../domain/plan-lint.ts";
import type { RunEvent } from "../domain/run-events.ts";
import type { DispatchAction } from "../domain/run-machine.ts";
import type { RunState } from "../domain/run-state.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { ledgerProgress, ledgerTasks } from "./ledger-store.ts";
import { PLAN_INPUT_DIR } from "./plan-input.ts";
import type { Run } from "./run-store.ts";

/** Plan 47: a delegated task's brief, written by delegate_task and sent as the task's whole round. */
export const taskBriefFile = (taskId: string): string => `tasks/${taskId}/brief.md`;
/** Spec D12: where a researcher task writes its answer. */
export const researchFile = (taskId: string): string => `research/${taskId}.md`;

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const MILESTONE = /^##\s+(M\d+)\b/gm;

/** Spec D2: the plan lint runs once, at the first turn, and its findings are warnings in that digest. */
function planWarnings(run: Run, s: RunState): string[] {
  return planInputNames(s.plan).flatMap((name) => {
    const text = read(join(run.dir, PLAN_INPUT_DIR, name));
    return [...text.matchAll(MILESTONE)].flatMap((m) =>
      lintPlan(text, m[1] as string, s.aLines).map((w) => `${name}: ${w}`),
    );
  });
}

/** The free slots, the digest's last line (spec D1: an idle box is visible to the one role that can fill it). */
function slotsLine(s: RunState): string {
  const tasks = Object.values(s.arch?.tasks ?? {});
  const working = tasks.filter((t) => t.state === "working");
  const standing = working.filter((t) => isStanding(t.role)).length;
  const queued = tasks.filter((t) => t.state === "queued").length;
  const checks = Object.values(s.arch?.checks ?? {}).filter((c) => c.state === "queued").length;
  return `Writers running: ${working.length - standing} of ${WRITER_CAP}. Standing roles (researcher, writer) running: ${standing} of ${STANDING_CAP}. Tasks queued: ${queued}. Checks queued or running: ${checks}.`;
}

/**
 * Spec D1: an architect turn's brief. A fresh thread gets the goal, the plan inputs, the first turn's plan lint and
 * where its ledger is; every turn gets the digest of what happened up to `a.upTo` and the free slots, last.
 */
export function wakeBrief(run: Run, s: RunState, a: DispatchAction): Pick<BriefParts, "unit" | "round"> {
  const read = (path: string) => `catherd run-file read ${run.id} ${path}`;
  const plan = planInputNames(s.plan).map((n) => `${PLAN_INPUT_DIR}/${n}`);
  const warnings = (s.arch?.turns ?? 0) === 0 ? planWarnings(run, s) : [];
  const unit = [
    `The run's goal: ${s.title}.\nIts acceptance lines:\n${s.aLines.map((l) => `- ${l}`).join("\n")}`,
    ...(plan.length
      ? [
          `The owner's plan files: ${plan.join(", ")} (${read("<path>")}). They are your input, not an approval: you may edit them.`,
        ]
      : []),
    ...(warnings.length ? [`Plan lint, warnings only:\n${warnings.map((w) => `- ${w}`).join("\n")}`] : []),
    `Your memory is the ledger: ledger/tasks.json and ledger/progress.md (${read("ledger/progress.md")}).`,
  ];
  const upTo = a.upTo ?? s.seq;
  const items = (s.arch?.inbox ?? []).filter((i) => i.seq <= upTo);
  const round = [
    ...(a.thread === null && (s.arch?.turns ?? 0) > 0
      ? [
          `This is a fresh thread${a.notes.length ? ` (${a.notes.join("; ")})` : ""}: read the ledger, then compare it with git log and the tree before you act.`,
        ]
      : []),
    items.length
      ? `What happened since your last turn:\n${items.map((i) => `- #${i.seq} ${i.text}`).join("\n")}`
      : "Nothing new happened since your last turn.",
    slotsLine(s),
  ];
  return { unit, round };
}

/**
 * Spec D8: what a review reads. Its snapshot is the tree when it was called; on a ledger task reviewed before, only
 * the diff since the last review's snapshot, and that review's findings, which it must not report again.
 */
function reviewLines(s: RunState, t: ArchTask): string[] {
  if (t.snapshot === null) return [];
  const sha = t.snapshot;
  const prev = t.ledgerTask === null ? undefined : lastReview(s.arch, t.ledgerTask);
  if (!prev?.snapshot)
    return [
      `The tree you review is commit ${sha}, taken when you were called: git diff ${sha}^ ${sha} is everything not yet committed then.`,
    ];
  const earlier = prev.findings.map(
    (f, n) => `- ${n + 1}. ${f.text}${prev.handled[n + 1] ? ` [${prev.handled[n + 1]}]` : ""}`,
  );
  return [
    `This is a re-review of ledger task ${t.ledgerTask}. ${prev.taskId} reviewed it as commit ${prev.snapshot}; you review commit ${sha}. Read only git diff ${prev.snapshot} ${sha} and the code it touches.`,
    earlier.length
      ? `${prev.taskId}'s findings, which you never report again (judge only whether the diff fixed them):\n${earlier.join("\n")}`
      : `${prev.taskId} found nothing.`,
  ];
}

/** Spec D3, D12: a delegated task's brief is only what its caller wrote, with where its result goes. */
export function taskBrief(run: Run, s: RunState, a: DispatchAction): Pick<BriefParts, "unit" | "round"> {
  const t = s.arch?.tasks[a.name];
  const text = read(join(run.dir, taskBriefFile(a.name))).trim();
  const where =
    t?.role === "researcher"
      ? `Write your answer to ${researchFile(a.name)} with catherd run-file write ${run.id} ${researchFile(a.name)}, cite file:line for every claim, and reply with that path.`
      : "Report every file you changed and why, one line each: EXTRA: <path> — <why>.";
  return {
    unit: [],
    round: [
      `You are task ${a.name}${t ? `, a ${t.role} delegated by ${t.by}` : ""}. You have no lane file: this task is your whole brief.`,
      text || "(the task's brief is missing: reply STATUS: blocked — needs_user: no brief)",
      ...(t?.role === "reviewer" ? reviewLines(s, t) : []),
      where,
    ],
  };
}

/** The verdict the architect gave, else how the run ended. */
const verdictLine = (s: RunState, events: RunEvent[]): string => {
  const f = events.findLast((e) => e.type === "run.finishing");
  if (f?.type === "run.finishing") return `Verdict: ${f.verdict} — ${f.why}`;
  return s.cancelling
    ? "Verdict: cancelled by the owner"
    : `Verdict: ${s.arch?.finishing?.verdict ?? "stopped"} — ${s.arch?.finishing?.why ?? ""}`;
};

/** Every architect call with its `why`, oldest first: the change log of the run (spec D3, D11's audit). */
function changeLog(events: RunEvent[]): string[] {
  return events.flatMap((e) =>
    "why" in e && typeof e.why === "string" && ("by" in e || e.type === "question.parked")
      ? [`- ${e.at} ${e.type} (${"by" in e ? String(e.by) : "architect"}): ${e.why}`]
      : [],
  );
}

/** Plan 47: an architect run's report: its verdict, the ledger, the last progress entries, the change log. */
export function writeArchitectReport(run: Run, s: RunState, events: RunEvent[]): string {
  const tasks = ledgerView(ledgerTasks(run), taskAttempts(s.arch));
  const progress = ledgerProgress(run).slice(-5);
  const lines = [
    `# ${s.title || run.meta.title}`,
    "",
    verdictLine(s, events),
    "",
    "## Ledger",
    "",
    ...(tasks.length
      ? tasks.map(
          (t) =>
            `- ${t.id} [${t.state}] ${t.goal}${t.attempts.length ? ` (${t.attempts.length} attempt${t.attempts.length === 1 ? "" : "s"})` : ""}`,
        )
      : ["No ledger task."]),
    "",
    "## Progress (last entries)",
    "",
    ...(progress.length ? progress.map((p) => `- ${p.at}: ${p.text}`) : ["No progress entry."]),
    "",
    "## Change log",
    "",
    ...changeLog(events),
    "",
  ];
  const file = join(run.dir, "report.md");
  writeTextAtomic(file, lines.join("\n"));
  return file;
}

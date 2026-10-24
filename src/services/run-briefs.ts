import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFindings } from "../domain/findings.ts";
import { JUDGE_CONTRACT, type JudgeInput, JUDGE_VERBS } from "../domain/judge.ts";
import { parseLaneHeader } from "../domain/lane.ts";
import { milestoneCheck, planInputNames } from "../domain/plan-doc.ts";
import { parseReplyDesign } from "../domain/record.ts";
import { RUN_UNIT } from "../domain/run-events.ts";
import type { Action } from "../domain/run-machine.ts";
import { unitMilestone } from "../domain/branch.ts";
import { integrateName, lanesOf, type MilestoneState, type RunState } from "../domain/run-state.ts";
import { VERSION } from "../infra/version.ts";
import { landedCommits } from "./milestones.ts";
import { readChecks } from "./milestone-check.ts";
import {
  deliveredALines,
  laneTasks,
  milestoneTasks,
  numberedALines,
  PLAN_INPUT_DIR,
  taskBlock,
} from "./plan-input.ts";
import { readRecords, type Run, runPaths } from "./run-store.ts";

type DispatchAction = Extract<Action, { type: "dispatch" }>;

const ALINES = (run: Run): string =>
  run.meta.aLines.length
    ? numberedALines(run.meta.aLines)
        .map((a) => `- ${a.line}`)
        .join("\n")
    : "- (none written)";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** The reply of the latest ended dispatch named `name`, by its path in the run folder; "" when there is none. */
function lastReply(run: Run, s: RunState, name: string): string {
  const d = Object.values(s.dispatches)
    .filter((x) => x.name === name && x.ended !== null)
    .at(-1);
  return d ? read(join(run.dir, "roles", name, d.dispatchId, "reply.md")) : "";
}

const READ_RULES = "If the repo has a CLAUDE.md or AGENTS.md, read it first and follow it.";

const DOSSIER = [
  "what past runs of this repo learned (read_knowledge), so you map only what changed since then;",
  "the files and folders involved, one line each on what they hold;",
  "the existing patterns the work should copy, by path;",
  "the build, test and run commands, with how long the full suite takes when the docs, the CI config or a log say so (never run the suite to find out: write unknown);",
  "the lint and type-check commands, and how to scope each to one package;",
  "the symbols the change will call or alter, with their signatures;",
  "the repo's rules (CLAUDE.md, AGENTS.md, conventions) that bind this work;",
  "risks: shared files, generated code, slow or flaky tests.",
];

/** The lane file header the architect writes: what `route`, `preflight` and `dispatch` read. */
const LANE_HEADER = [
  "Every lane file starts with these lines:",
  "  # Mx.Ly — <title>",
  "  Owns: <repo-relative paths, a trailing / for a folder, never a glob>",
  "  Fast check: <the lane's targeted tests plus the linter of every package it touches, and the type check when the repo has one, scoped to those packages>",
  "  Kind: repo_code|terminal|ui|prose|research",
  "  Difficulty: copy|build|logic|hard",
  "  Tasks: <plan task numbers, comma-separated; <plan file>#<n> when the run has several plan files>",
  "Three optional lines follow: `After: Mx.Ly, …` when the lane compiles against another lane's changes; `Allow: path[:line], …` under a fast check that greps for absence, naming the hits that are allowed exceptions; and `Reference: <repo path>` when the lane builds something with a close sibling in the repository.",
  "Two lanes of one milestone never own the same file.",
];

function architectBrief(run: Run, s: RunState, a: DispatchAction): string {
  // a milestone's call-back carries review findings; the run's own notes are what the owner or the plan check asked to change
  const delta = a.notes.length > 0 && a.unit !== RUN_UNIT;
  const dossier = join(run.dir, "dossier.md");
  if (delta)
    return [
      `You are the architect of catherd run ${run.id} (${run.meta.title}), called back on ${a.unit}: its review found things the plan does not cover.`,
      "",
      "Findings the lanes' owners cannot fix, verbatim:",
      ...a.notes.map((n) => `- ${n}`),
      "",
      `Read ${join(run.dir, "plan.md")} and the lane files, then change only what these findings need: edit a lane file, or add a lane to ${a.unit} with a fresh id (the next M<n>.L<k>). Lanes that are done keep their ids. Write with write_run_file. ${READ_RULES}`,
      "",
      ...LANE_HEADER,
    ].join("\n");
  return [
    `You are the architect of catherd run ${run.id} (${run.meta.title}), run folder ${run.dir}.`,
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    "",
    s.plan.length
      ? `The owner's approved plan: ${planInputNames(s.plan)
          .map((n) => `${PLAN_INPUT_DIR}/${n}`)
          .join(
            ", ",
          )} (read each with read_run_file). Lane the tasks the acceptance lines name, or every task when they name none.`
      : `No plan was given: write plan.md to the depth your role text sets. The run waits for the owner's approval of it before any lane runs. Read the dossier first: ${existsSync(dossier) ? dossier : "dossier.md in the run folder"}.`,
    ...(a.notes.length ? ["", "What to change:", ...a.notes.map((n) => `- ${n}`)] : []),
    "",
    "Write plan.md and every lanes/Mx.Ly.md yourself with write_run_file. In plan.md, one heading per milestone, `## M1 — <title>`, then its full check (the whole suite), and an `After: M0, …` line only when the milestone needs another milestone landed first (none otherwise, so a parked milestone does not hold the rest).",
    "Every A-line above must be cited as A<n> under the milestone that delivers it, in that milestone's section of plan.md (a line per A-line, starting with its id); one milestone may own several, and catherd sends back a plan that leaves one without a milestone.",
    "A full check slower than about five minutes is a problem to solve: make speeding it up an early lane.",
    ...(s.base !== null
      ? [
          "",
          `In this run each milestone is its own branch and merge request from origin/${s.base}, and milestones run side by side: a milestone that builds on another's code names it on its first lane's After: line (After: M1), and only those wait. When a fresh checkout needs a command before anything runs (installing dependencies, generating code), put Setup: <command> on the line under plan.md's # title.`,
        ]
      : []),
    "",
    ...LANE_HEADER,
    "",
    READ_RULES,
  ].join("\n");
}

/** A fix round's worker sees this many lines of the failing milestone check's log. */
export const CHECK_LOG_TAIL_LINES = 40;

/**
 * The end of the milestone's latest check in this run, when it failed (a later passing one removes it): what a
 * fix round starts from when the finding names only the check.
 */
function failingCheck(run: Run, milestone: string): string[] {
  const last = readChecks(run.meta.repo)
    .filter((r) => r.run === run.id && r.milestone === milestone && !r.baseline)
    .at(-1);
  if (!last || last.exit === 0) return [];
  let tail: string;
  try {
    tail = readFileSync(last.log, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .slice(-CHECK_LOG_TAIL_LINES)
      .join("\n");
  } catch {
    tail = `(log unreadable: ${last.log})`;
  }
  return [
    "",
    `The milestone check \`${last.command}\` exited ${last.exit} on ${last.head.slice(0, 12)}; the end of its log:`,
    "```",
    tail,
    "```",
  ];
}

/** A lane's plan tasks, verbatim; nothing for a lane that names none. */
function planTasks(run: Run, lane: string): string[] {
  const tasks = laneTasks(run, lane);
  return tasks.length
    ? [
        "",
        "Your plan tasks. Implement them as written; where one conflicts with the code, reply DESIGN: as your role text says.",
        ...tasks.map(taskBlock),
      ]
    : [];
}

/** The fast check of each lane of a milestone: a fix worker reruns those whose files it changes. */
function fastChecks(run: Run, s: RunState, milestone: string): string[] {
  const rows = lanesOf(s, milestone).flatMap((l) => {
    const check = parseLaneHeader(read(join(runPaths(run.dir).lanes, `${l.id}.md`))).fastCheck;
    return check ? [`- ${l.id} (${l.owns.join(", ")}): \`${check}\``] : [];
  });
  return rows.length
    ? ["", `The fast checks of ${milestone}'s lanes; run the ones whose files you change:`, ...rows]
    : [];
}

/** A research answer past this many characters is cut, and the brief says how many. */
export const RESEARCH_ANSWER_CHARS = 4000;

/**
 * Plan 34: one block per `After:` lane of `lane` that is a research lane with an answer: the reply of its latest
 * ok record that was not blocked or refused, its closing STATUS line cut. A reply that cannot be read adds nothing.
 */
export function researchAnswers(run: Run, s: RunState, lane: string): string[] {
  const out: string[] = [];
  for (const id of s.lanes[lane]?.after ?? []) {
    if (s.lanes[id]?.kind !== "research") continue;
    const latest = readRecords(run)
      .records.filter(
        (r) =>
          r.lane === id && r.status === "ok" && r.replyStatus !== "blocked" && r.replyStatus !== "refused",
      )
      .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
      .at(-1);
    if (!latest?.replyPath) continue;
    const answer = read(join(run.dir, latest.replyPath))
      .replace(/\s*STATUS:[^\n]*\s*$/i, "")
      .trim();
    if (!answer) continue;
    const cut = answer.length - RESEARCH_ANSWER_CHARS;
    out.push(
      `${id} (research) answered:\n${
        cut > 0 ? `${answer.slice(0, RESEARCH_ANSWER_CHARS)}\n[… ${cut} more characters cut]` : answer
      }`,
    );
  }
  return out;
}

function workerBrief(run: Run, s: RunState, a: DispatchAction): string {
  const lane = s.lanes[a.unit];
  const fix = a.brief === "fix";
  return [
    `You are ${a.name}, a ${a.role} of catherd run ${run.id} (${run.meta.title}). Your lane is ${a.unit}${lane ? `, in milestone ${lane.milestone}` : ""}; its file is below.`,
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    "",
    `Own only the files on your lane's Owns: line; change nothing else. ${READ_RULES}`,
    ...planTasks(run, a.unit),
    ...(fix
      ? [
          "",
          "This is a fix round. Fix exactly these, each as it was reported, and nothing beside them:",
          ...a.notes.map((n) => `- ${n}`),
          ...(a.notes.length && lane ? failingCheck(run, lane.milestone) : []),
          ...(lane ? fastChecks(run, s, lane.milestone) : []),
        ]
      : []),
    "",
    `Run your fast check until it passes. Run the full suite only if this brief says so, and wrap any full build or full test suite in: bunx catherd-cli@${VERSION} lock -- <command>. Other lanes share this machine.`,
    ...researchAnswers(run, s, a.unit).flatMap((block) => ["", block]),
  ].join("\n");
}

/** The worker that finishes a merge of the base into the run's branch: git left these files in conflict. */
function integrateBrief(run: Run, s: RunState, a: DispatchAction): string {
  return [
    `You are ${a.name} of catherd run ${run.id} (${run.meta.title}). The base branch ${s.base ?? ""} moved while milestone ${a.unit} was being verified, and catherd merged it into the run's branch. The merge stopped on conflicts in the repository you are in:`,
    ...a.notes.map((n) => `- ${n}`),
    "",
    "Resolve every conflict, keeping both sides' intent: the base's change and this run's. Edit the conflicted files only, remove every conflict marker, and do not commit or stage anything (no git add, no git commit): catherd does.",
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    "",
    READ_RULES,
  ].join("\n");
}

function milestoneBase(run: Run): string {
  return landedCommits(run).at(-1) ?? run.meta.startHead ?? "HEAD~1";
}

/** The milestone's plan tasks, and every file a lane changed outside its Owns, declared on an EXTRA: line or not. */
function reviewPlan(run: Run, s: RunState, milestone: string): string[] {
  const tasks = milestoneTasks(run, milestone);
  const { records } = readRecords(run);
  const outside = lanesOf(s, milestone).flatMap((l) => {
    const r = records.filter((x) => x.lane === l.id).at(-1);
    if (!r) return [];
    const declared = r.extras ?? [];
    return [
      ...declared.map((e) => `- ${e.path} — declared by ${r.name}${e.why ? `: ${e.why}` : ""}`),
      ...r.violations
        .filter((v) => !declared.some((e) => e.path === v))
        .map((v) => `- ${v} — not declared by ${r.name}`),
    ];
  });
  return [
    ...(tasks.length ? ["", "The plan tasks this milestone implements:", ...tasks.map(taskBlock)] : []),
    ...(outside.length ? ["", "Files changed outside their lane:", ...outside] : []),
  ];
}

/** The findings a fix round rejected since the milestone's latest review ended, for the re-check to judge. */
function rejections(run: Run, s: RunState, milestone: string): string[] {
  const reviewed = Object.values(s.dispatches)
    .filter((d) => (d.name === `reviewer-${milestone}` || d.name === `reviewer-${milestone}-2`) && d.ended)
    .map((d) => (d.ended as { at: string }).at)
    .sort()
    .at(-1);
  const lanes = new Set(lanesOf(s, milestone).map((l) => l.id));
  const rows = readRecords(run).records.flatMap((r) =>
    r.lane && lanes.has(r.lane) && (reviewed === undefined || r.endedAt > reviewed)
      ? (r.rejected ?? []).map((x) => `- ${r.name}: REJECTED: ${x.finding}${x.why ? ` — ${x.why}` : ""}`)
      : [],
  );
  return rows.length
    ? [
        "",
        "A fix round rejected these findings instead of changing the code. Judge each reason: a finding whose reason holds is closed; one whose reason does not hold stands, with your answer to the reason.",
        ...rows,
      ]
    : [];
}

function reviewBrief(run: Run, s: RunState, a: DispatchAction): string {
  const m = s.milestones.find((x) => x.id === a.unit);
  const base = milestoneBase(run);
  const ui = a.role === "ui-reviewer";
  const head = `You review milestone ${a.unit}${m ? ` (${m.title})` : ""} of catherd run ${run.id}${ui ? ", by its screens" : ""}. You did not write it. Change nothing in the project.`;
  const range = s.base
    ? `The milestone is its branch's diff from origin/${s.base}: read \`git diff origin/${s.base}...HEAD\` and \`git diff --name-only origin/${s.base}...HEAD\` (three dots: other milestones land on the base meanwhile); read new files in full.`
    : `The milestone is the commit range ${base}..HEAD: read \`git diff ${base}..HEAD\` and \`git diff --name-only ${base}..HEAD\`; read new files in full.`;
  if (a.brief === "recheck") {
    const second = a.name.endsWith("-2");
    const first = lastReply(run, s, `reviewer-${a.unit}`);
    const open = parseFindings(first).filter((f) => f.label !== "NIT");
    return second
      ? [
          head,
          range,
          "",
          `reviewer-${a.unit} replied STATUS: partial: it read only part of the diff. Its reply, which names the files it did not read:`,
          first.trim().split("\n").slice(-40).join("\n"),
          "",
          "Review those files only, and report every finding as BLOCKER|BUG|NIT file:line — problem — fix. With no finding, the reply is CLEAN.",
        ].join("\n")
      : [
          head,
          range,
          "",
          `This is a re-check: the lines you reported last time were fixed in ${m?.commit?.slice(0, 12) ?? "HEAD"}. Re-check only these BLOCKER and BUG lines, and report each that is still open as it was, plus any new BLOCKER or BUG the fixes introduced:`,
          ...open.map((f) => `- ${f.text}`),
          ...reviewPlan(run, s, a.unit),
          ...rejections(run, s, a.unit),
          "",
          "With none open and none new, the reply is CLEAN.",
        ].join("\n");
  }
  if (ui)
    return [
      head,
      range,
      "",
      "Start the app yourself (the repo's docs say how). Map the changed files to the screens that render them and review those screens only, at viewport size, not full page, in each theme: agent-browser screenshot <path> to the run folder's shots/ directory, and open each PNG yourself before you judge it. If you cannot start the app, reply STATUS: blocked and say why.",
      "",
      "Report every finding as: BLOCKER|BUG|NIT <screen> — problem — fix — <screenshot path>, always with the path. With no finding, the reply is CLEAN.",
      "",
      "The A-lines this run must meet:",
      ALINES(run),
    ].join("\n");
  return [
    head,
    range,
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    ...reviewPlan(run, s, a.unit),
    "",
    "Report every finding as: BLOCKER|BUG|NIT file:line — problem — fix. Cover:",
    "- unmet A-lines and edge cases;",
    "- code or abstractions nobody needs;",
    "- comments that restate code;",
    "- tests that assert nothing.",
    "",
    "With no finding, the reply is CLEAN.",
  ].join("\n");
}

/**
 * plan 40: the verifier's lines once its milestone's Check passed on its commit: the acceptance lines the Check does not
 * show, and nothing else. A milestone with no Check line has no command, so no such run: null.
 */
function checkedLines(m: MilestoneState | undefined, command: string | null): string[] | null {
  if (!m || command === null || m.commit === null || m.checkedOn !== m.commit) return null;
  return [
    `catherd ran this milestone's Check (${command}) on ${m.commit.slice(0, 12)} and it passed: do not run it again. ${m.uncovered.length ? "Judge only these acceptance lines, which the Check does not show:" : "No acceptance line of this milestone is left for you: judge its diff."}`,
    ...m.uncovered.map((line) => `- ${line}`),
    "",
    READ_RULES,
    "",
  ];
}

function verifyBrief(run: Run, s: RunState, a: DispatchAction): string {
  const m = s.milestones.find((x) => x.id === a.unit);
  const planFile = runPaths(run.dir).plan;
  const plan = existsSync(planFile) ? readFileSync(planFile, "utf8") : "";
  const delivered = [...deliveredALines(run, plan, a.unit)].sort((x, y) =>
    x.localeCompare(y, "en", { numeric: true }),
  );
  const previous = lastReply(run, s, a.name)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1, 13);
  const checked = checkedLines(m, milestoneCheck(plan, a.unit));
  return [
    `You verify milestone ${a.unit}${m ? ` (${m.title})` : ""} of catherd run ${run.id}: you own the independent gate. The commit under test is ${m?.commit ?? "HEAD"}; the tree is frozen.`,
    "",
    ...(checked ?? [
      "The A-lines this run must meet:",
      ALINES(run),
      "",
      `Run the milestone's full check, named under "## ${a.unit}" in ${join(run.dir, "plan.md")}, and each lane's fast check where the full check does not cover it. ${READ_RULES}`,
      "",
      ...(delivered.length
        ? [
            `This milestone delivers ${delivered.join(", ")}: report each as \`A<n> PASS|FAIL\`, with the command you ran and the decisive output.`,
            "",
          ]
        : []),
    ]),
    ...(a.notes.length ? ["Before you start:", ...a.notes.map((n) => `- ${n}`), ""] : []),
    // a Check that passed now replaces the gate items the last verifier failed: "run those items first" would repeat it
    ...(previous.length && !checked
      ? [
          "A verifier failed this milestone before; it said:",
          ...previous.map((l) => `- ${l}`),
          "Run those items first.",
          "",
        ]
      : []),
    "The first line of your reply is the verdict: VERDICT: PASS, VERDICT: FAIL, or VERDICT: BLOCKED: environment — <the probe that proves it>. On FAIL, list each failing item on its own line below, starting the line with `FAIL` and giving the file and the command that failed.",
  ].join("\n");
}

function researchBrief(run: Run): string {
  return [
    `You are the researcher of catherd run ${run.id} (${run.meta.title}). Map the code the A-lines touch into a dossier.`,
    "",
    "The A-lines:",
    ALINES(run),
    "",
    `A dossier lists, with file:line everywhere:`,
    ...DOSSIER.map((d) => `- ${d}`),
    "",
    `It may run to 200 lines; the 15-line cap does not apply to it. Write it with write_run_file to dossier.md, and reply with that path. ${READ_RULES}`,
  ].join("\n");
}

/** Plan 35 D8: the tree, branch and diff of a base-run milestone that has its worktree; nothing otherwise. */
function branchLine(s: RunState, a: DispatchAction): string[] {
  const m = s.base === null ? undefined : s.milestones.find((x) => x.id === unitMilestone(a.unit));
  if (!m?.tree || s.base === null) return [];
  return [
    `You work in ${m.tree}, on branch ${m.branch ?? ""}, which starts from origin/${s.base}. The milestone's diff is \`git diff origin/${s.base}...HEAD\`: three dots, because other milestones land on the base meanwhile and a two-dot diff shows their work as deleted here.`,
  ];
}

/** The brief of one dispatch: what its role is to do, from the run's own facts. Admission adds the lane file and the reply contract. */
export function briefFor(run: Run, s: RunState, a: DispatchAction): string {
  const text = [briefBody(run, s, a), ...branchLine(s, a)].join("\n\n");
  // a lane's answers ride in its own notes; a milestone's go to every role that works on it; the run's, to planning
  const answered = a.lane
    ? []
    : a.unit === RUN_UNIT
      ? s.notes
      : (s.milestones.find((m) => m.id === a.unit)?.notes ?? []);
  return answered.length ? `${text}\n\n${answered.join("\n")}` : text;
}

function briefBody(run: Run, s: RunState, a: DispatchAction): string {
  switch (a.brief) {
    case "dossier":
      return researchBrief(run);
    case "architect":
      return architectBrief(run, s, a);
    case "lane":
    case "fix":
      return a.name === integrateName(a.unit) ? integrateBrief(run, s, a) : workerBrief(run, s, a);
    case "review":
    case "recheck":
      return reviewBrief(run, s, a);
    case "verify":
      return verifyBrief(run, s, a);
    case "judge":
      return `You are ${a.name} of catherd run ${run.id}. ${JUDGE_CONTRACT}`;
  }
}

const REPLY_TAIL = 3000;

/** The rules review's brief (plan 34): a finished run's judge reads its files and proposes changes to the standing rules. */
export const RULES_REVIEW_BRIEF =
  "Rules review: this run is over. Read its events.jsonl, digests/ and lanes/ with read_run_file, and the repo's standing rules with read_knowledge (one rule per line; a [role, …] tag after the source scopes a line to those roles). Propose at most five changes, each with the event it comes from: a one-line rule that would have prevented a review round, a failed check, a climb or a question (tagged [role, …] when it is not for every role), or the removal of a line that is stale, covers one past incident only, or repeats another. Propose no change when none would have helped. Write nothing.";

/** The judge's brief: its kind and unit, the context, the numbered findings and the lanes, nothing else. */
export function judgeBrief(run: Run, input: JudgeInput): string {
  if (input.kind === "rules")
    return [
      RULES_REVIEW_BRIEF,
      "",
      input.context,
      "",
      `Kind: ${input.kind}. Unit: ${input.unit}. Your verbs: ${JUDGE_VERBS[input.kind].join(", ")}.`,
    ].join("\n");
  const reply = /^reply: (\S+)$/m.exec(input.context)?.[1];
  const tail = reply ? read(join(run.dir, reply)).trimEnd().slice(-REPLY_TAIL) : "";
  const verbs = JUDGE_VERBS[input.kind].join(", ");
  // a worker's DESIGN: line (in the reply, or quoted in the context) is a conflict between the plan and the code
  const design =
    input.kind === "question" &&
    (/^\s*DESIGN:/m.test(input.context) ||
      parseReplyDesign(reply ? read(join(run.dir, reply)) : "").length > 0);
  return [
    `You are the judge of catherd run ${run.id} (${run.meta.title}). One decision, from only what this brief gives you and the run's files (${run.dir}). You never edit a file.`,
    "",
    `Kind: ${input.kind}. Unit: ${input.unit}. Your verbs: ${verbs}.`,
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    "",
    input.context,
    ...(design
      ? [
          "",
          "The worker's DESIGN: line says the approved plan conflicts with the code. Answer only when the plan itself settles it (another task, its contracts, its decisions); a change to what the plan decided is the owner's: ask_owner.",
          ...laneTasks(run, input.unit).map(taskBlock),
        ]
      : []),
    ...(tail ? ["", "The reply's last lines:", tail] : []),
    ...(input.findings.length ? ["", "Findings:", ...input.findings.map((f, i) => `${i + 1}. ${f}`)] : []),
    "",
    "Lanes of the milestone and what each owns:",
    ...input.lanes.map((l) => `- ${l.id}: ${l.owns.join(", ") || "(nothing)"}`),
  ].join("\n");
}

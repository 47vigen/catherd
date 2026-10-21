import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFindings } from "../domain/findings.ts";
import { JUDGE_CONTRACT, type JudgeInput, JUDGE_VERBS } from "../domain/judge.ts";
import type { Action } from "../domain/run-machine.ts";
import type { RunState } from "../domain/run-state.ts";
import { VERSION } from "../infra/version.ts";
import { landedCommits } from "./milestones.ts";
import type { Run } from "./run-store.ts";

type DispatchAction = Extract<Action, { type: "dispatch" }>;

const ALINES = (run: Run): string =>
  run.meta.aLines.length ? run.meta.aLines.map((a) => `- ${a}`).join("\n") : "- (none written)";

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
  "Two optional lines follow: `After: Mx.Ly, …` when the lane compiles against another lane's changes, and `Allow: path[:line], …` under a fast check that greps for absence, naming the hits that are allowed exceptions.",
  "Two lanes of one milestone never own the same file.",
];

function architectBrief(run: Run, s: RunState, a: DispatchAction): string {
  const delta = a.notes.length > 0;
  const plans = s.plan;
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
    plans.length
      ? `A plan is in hand: ${plans.join(", ")}. Translate it, do not design: each plan task becomes lanes, each MR or phase a milestone with its full check. Copy its decisions into plan.md and the lane files, redesign only what it leaves undecided.`
      : `Read the dossier first: ${existsSync(dossier) ? dossier : "dossier.md in the run folder"}.`,
    "",
    "Write plan.md and every lanes/Mx.Ly.md yourself with write_run_file. In plan.md, one heading per milestone, `## M1 — <title>`, then its full check (the whole suite), and an `After: M0, …` line only when the milestone needs another milestone landed first (none otherwise, so a parked milestone does not hold the rest).",
    "A full check slower than about five minutes is a problem to solve: make speeding it up an early lane.",
    "",
    ...LANE_HEADER,
    "",
    READ_RULES,
  ].join("\n");
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
    ...(fix
      ? [
          "",
          "This is a fix round. Fix exactly these, each as it was reported, and nothing beside them:",
          ...a.notes.map((n) => `- ${n}`),
        ]
      : []),
    "",
    `Run your fast check until it passes. Run the full suite only if this brief says so, and wrap any full build or full test suite in: bunx catherd-cli@${VERSION} lock -- <command>. Other lanes share this machine.`,
  ].join("\n");
}

function milestoneBase(run: Run): string {
  return landedCommits(run).at(-1) ?? run.meta.startHead ?? "HEAD~1";
}

function reviewBrief(run: Run, s: RunState, a: DispatchAction): string {
  const m = s.milestones.find((x) => x.id === a.unit);
  const base = milestoneBase(run);
  const ui = a.role === "ui-reviewer";
  const head = `You review milestone ${a.unit}${m ? ` (${m.title})` : ""} of catherd run ${run.id}${ui ? ", by its screens" : ""}. You did not write it. Change nothing in the project.`;
  const range = `The milestone is the commit range ${base}..HEAD: read \`git diff ${base}..HEAD\` and \`git diff --name-only ${base}..HEAD\`; read new files in full.`;
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

function verifyBrief(run: Run, s: RunState, a: DispatchAction): string {
  const m = s.milestones.find((x) => x.id === a.unit);
  const previous = lastReply(run, s, a.name)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(1, 13);
  return [
    `You verify milestone ${a.unit}${m ? ` (${m.title})` : ""} of catherd run ${run.id}: you own the independent gate. The commit under test is ${m?.commit ?? "HEAD"}; the tree is frozen.`,
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    "",
    `Run the milestone's full check, named under "## ${a.unit}" in ${join(run.dir, "plan.md")}, and each lane's fast check where the full check does not cover it. ${READ_RULES}`,
    "",
    ...(previous.length
      ? [
          "A verifier failed this milestone before; it said:",
          ...previous.map((l) => `- ${l}`),
          "Run those items first.",
          "",
        ]
      : []),
    "The first line of your reply is the verdict: VERDICT: PASS, VERDICT: FAIL, or VERDICT: BLOCKED: environment — <the probe that proves it>. On FAIL, list each failing item on its own line below, with the file and the command that failed.",
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

/** The brief of one dispatch: what its role is to do, from the run's own facts. Admission adds the lane file and the reply contract. */
export function briefFor(run: Run, s: RunState, a: DispatchAction): string {
  const text = briefBody(run, s, a);
  // a lane's answers ride in its own notes; a milestone's go to every role that works on it
  const answered = a.lane ? [] : (s.milestones.find((m) => m.id === a.unit)?.notes ?? []);
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
      return workerBrief(run, s, a);
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

/** The judge's brief: its kind and unit, the context, the numbered findings and the lanes, nothing else. */
export function judgeBrief(run: Run, input: JudgeInput): string {
  const reply = /^reply: (\S+)$/m.exec(input.context)?.[1];
  const tail = reply ? read(join(run.dir, reply)).trimEnd().slice(-REPLY_TAIL) : "";
  const verbs = JUDGE_VERBS[input.kind].join(", ");
  return [
    `You are the judge of catherd run ${run.id} (${run.meta.title}). One decision, from only what this brief gives you and the run's files (${run.dir}). You never edit a file.`,
    "",
    `Kind: ${input.kind}. Unit: ${input.unit}. Your verbs: ${verbs}.`,
    "",
    "The A-lines this run must meet:",
    ALINES(run),
    "",
    input.context,
    ...(tail ? ["", "The reply's last lines:", tail] : []),
    ...(input.findings.length ? ["", "Findings:", ...input.findings.map((f, i) => `${i + 1}. ${f}`)] : []),
    "",
    "Lanes of the milestone and what each owns:",
    ...input.lanes.map((l) => `- ${l.id}: ${l.owns.join(", ") || "(nothing)"}`),
  ].join("\n");
}

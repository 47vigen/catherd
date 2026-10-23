import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import {
  passBar,
  SCORECARD_TASKS,
  type ScorecardFile,
  type ScorecardTaskId,
  type Verdict,
} from "../domain/scorecard.ts";
import {
  defaultPreparedRoot,
  loadTask,
  type Prepared,
  prepareTask,
  readScorecard,
  resultsFile,
  saveTaskScore,
  scoreTask,
  scorecardRoot,
} from "../services/scorecard.ts";
import { JSON_ARG, mark, printJson, refuseInRole } from "./cli-kit.ts";

const BASELINE = "1.5.0";

/** POSIX single-quote escaping; a value of plain path characters stays bare. */
const quote = (v: string): string => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`);

/** The prepared task as the operator needs it: where to start, what to paste, and how to record. */
export function formatPrepared(p: Prepared, label = "<label>"): string[] {
  const env =
    p.limits && p.shim ? `CATHERD_SCORECARD_LIMITS=${quote(p.limits)} PATH=${quote(p.shim)}:"$PATH" ` : "";
  return [
    `${mark("ok")} ${p.task} prepared in ${p.dir} at ${p.startCommit.slice(0, 8)}`,
    `  start:  cd ${quote(p.repo)} && ${env}claude`,
    `  prompt: ${p.prompt}`,
    `  record: catherd scorecard record ${quote(p.dir)} --label ${label}`,
  ];
}

const yes = (b: boolean): string => (b ? "yes" : "no");
const num = (n: number): string => String(Math.round(n * 10) / 10);
const k = (n: number): string => `${Math.round(n / 1000)}k`;

function row(id: ScorecardTaskId, current: ScorecardFile, baseline: ScorecardFile | null): string {
  const s = current.tasks[id];
  if (!s) return `${id}  -`;
  const was = baseline?.tasks[id];
  const input = s.quota.backends.reduce((n, b) => n + b.input, 0);
  const output = s.quota.backends.reduce((n, b) => n + b.output, 0);
  return [
    id,
    s.catherdVersion,
    `finished ${yes(s.finished)}`,
    `interventions ${s.interventions.total}`,
    `rounds ${s.reviewRounds}`,
    `wall ${num(s.wallMinutes)} min (${was ? num(was.wallMinutes) : "?"} min)`,
    `first try ${yes(s.firstTry)}`,
    `quota ${k(input)}/${k(output)}`,
  ].join("  ");
}

export function formatComparison(
  current: ScorecardFile,
  baseline: ScorecardFile | null,
  v: Verdict,
): string[] {
  return [
    `scorecard ${current.label} against ${baseline ? baseline.label : "no baseline"}`,
    ...SCORECARD_TASKS.map((id) => row(id, current, baseline)),
    ...v.notes.map((n) => `NOTE: ${n}`),
    ...(v.pass ? ["PASS"] : v.failures.map((f) => `FAIL: ${f}`)),
  ];
}

/** The contributor commands read fixtures from the checkout; an installed package ships none. */
function checkoutRoot(): string {
  const root = scorecardRoot();
  if (!root)
    throw new CatherdError("E_INPUT_INVALID", "this catherd is not a source checkout", {
      fix: "run it from a catherd checkout: bun src/cli.ts scorecard …",
    });
  return root;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

const RESULTS_ARG = {
  results: { type: "string", description: "results folder (default: scorecard/results)" },
} as const;
const resultsDir = (root: string, given: string | undefined): string =>
  given ? resolve(given) : join(root, "results");

const prepare = defineCommand({
  meta: { name: "prepare", description: `Prepare a task's starting point: ${SCORECARD_TASKS.join(", ")}` },
  args: {
    task: { type: "positional", required: true, description: SCORECARD_TASKS.join("|") },
    source: {
      type: "string",
      description: "the repository to clone (a path or URL); the Sanitell task needs one",
    },
    dir: { type: "string", description: "where prepared tasks go (default: catherd's data dir)" },
    setup: {
      type: "boolean",
      default: true,
      description: "run the task's setup commands (--no-setup skips them)",
    },
    ...JSON_ARG,
  },
  async run({ args }) {
    refuseInRole(process.env, "catherd scorecard prepare");
    const root = checkoutRoot();
    const task = loadTask(args.task, root);
    const now = new Date();
    const into = join(args.dir ? resolve(args.dir) : defaultPreparedRoot(), `${task.id}-${stamp(now)}`);
    const p = await prepareTask({ task, root, into, source: args.source, now, setup: args.setup });
    if (args.json) return printJson(p);
    for (const line of formatPrepared(p)) console.log(line);
  },
});

const record = defineCommand({
  meta: { name: "record", description: "Score a prepared task's run and store its row under a label" },
  args: {
    dir: { type: "positional", required: true, description: "the folder `prepare` printed" },
    label: {
      type: "string",
      required: true,
      description: "a version or plan name: 1.5.0, plan-29, 2.0.0-beta.1",
    },
    run: { type: "string", description: "the run to score, when the folder holds more than one" },
    chat: { type: "string", description: "messages you typed into the session after the start prompt" },
    ...RESULTS_ARG,
    ...JSON_ARG,
  },
  async run({ args }) {
    refuseInRole(process.env, "catherd scorecard record");
    const chat = args.chat === undefined ? 0 : Number(args.chat);
    if (!Number.isInteger(chat) || chat < 0)
      throw new CatherdError("E_INPUT_INVALID", `--chat ${args.chat} is not a count`, {
        fix: "--chat <the number of messages you typed into the session>",
      });
    const root = checkoutRoot();
    const out = resultsFile(resultsDir(root, args.results), args.label);
    const s = await scoreTask({ dir: resolve(args.dir), root, run: args.run, chat, now: Date.now() });
    const saved = await saveTaskScore(out, args.label, s);
    if (args.json) return printJson({ file: out, score: s });
    const baseline = readScorecard(resultsFile(resultsDir(root, args.results), BASELINE));
    console.log(
      formatComparison(saved, baseline, passBar(saved, baseline))[1 + SCORECARD_TASKS.indexOf(s.task)],
    );
    console.log(out);
  },
});

const compare = defineCommand({
  meta: {
    name: "compare",
    description: `Check a label against the baseline (${BASELINE}) by the spec's pass bar`,
  },
  args: {
    label: { type: "positional", required: true, description: "the label to check" },
    baseline: { type: "string", description: `the label to compare with (default: ${BASELINE})` },
    ...RESULTS_ARG,
    ...JSON_ARG,
  },
  run({ args }) {
    const dir = resultsDir(checkoutRoot(), args.results);
    const current = readScorecard(resultsFile(dir, args.label));
    if (!current)
      throw new CatherdError("E_INPUT_INVALID", `no scorecard ${args.label} yet`, {
        fix: `catherd scorecard record <dir> --label ${args.label}`,
      });
    const baseline = readScorecard(resultsFile(dir, args.baseline ?? BASELINE));
    const verdict = passBar(current, baseline);
    process.exitCode = verdict.pass ? 0 : 1;
    if (args.json) return printJson({ current, baseline, verdict });
    for (const line of formatComparison(current, baseline, verdict)) console.log(line);
  },
});

export const scorecardCommand = defineCommand({
  meta: {
    name: "scorecard",
    description: "Contributors: measure a catherd version on four fixed tasks against the 1.5.0 baseline",
  },
  subCommands: { prepare, record, compare },
});

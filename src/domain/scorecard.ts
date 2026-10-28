import { z } from "zod";
import { CatherdError } from "./errors.ts";
import { median, type RunMetrics } from "./run-metrics.ts";

export const SCORECARD_TASKS = [
  "raqam-myanmar",
  "catherd-findings",
  "sanitell-payment-3",
  "injected-lao",
] as const;
export type ScorecardTaskId = (typeof SCORECARD_TASKS)[number];
export const INJECTED_TASK: ScorecardTaskId = "injected-lao";

/** The spec's "no worse than 1.5", read as the four tasks' summed wall-clock within 10 % (plan 28, ruling 6). */
export const WALL_TOLERANCE = 0.1;

const text = z.string().min(1);

export const ScorecardTaskSchema = z.strictObject({
  schema: z.literal(1),
  id: z.enum(SCORECARD_TASKS),
  title: text,
  goal: text,
  source: text.nullable(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  plan: z.union([z.strictObject({ file: text }), z.strictObject({ repoPath: text })]),
  inject: z
    .strictObject({
      message: text,
      edits: z.array(z.strictObject({ path: text, find: text, replace: z.string() })).min(1),
    })
    .nullable()
    .default(null),
  limits: z.number().int().min(0).default(0),
  setup: z.array(text).default([]),
  acceptance: text,
  acceptanceTimeoutMin: z.number().int().positive(),
  acceptFiles: z.array(z.strictObject({ from: text, to: text })).default([]),
  prompt: z.string().includes("{plan}"),
});
export type ScorecardTask = z.infer<typeof ScorecardTaskSchema>;

export interface Interventions {
  parks: number;
  answers: number;
  takeovers: number;
  manualDispatches: number;
  pauses: number;
  superseded: number;
  chat: number;
  /** the owner's cancel requests (a daemon run) */
  cancels: number;
  /** the owner's plan approvals, not a plan given as input (a daemon run) */
  approvals: number;
  total: number;
}

export interface QuotaRow {
  backend: string;
  runs: number;
  input: number;
  cached: number;
  output: number;
  limits: number;
}

export interface TaskScore {
  task: ScorecardTaskId;
  run: string;
  catherdVersion: string;
  startCommit: string;
  head: string | null;
  milestones: string[];
  landed: string[];
  finished: boolean;
  interventions: Interventions;
  reviewRounds: number;
  lanes: { total: number; landed: number; climbs: number };
  wallMinutes: number;
  pausedMinutes: number;
  quota: { backends: QuotaRow[]; claudeAgentTokens: number };
  acceptance: { passed: boolean; code: number | null; timedOut: boolean; tail: string[] };
  firstTry: boolean;
  injected: { limits: number; standInOk: boolean } | null;
  recordedAt: string;
  /** plan 51, spec D17: the run's metrics; absent on a row an earlier build recorded */
  metrics?: RunMetrics | null;
}

export interface ScorecardFile {
  schema: 1;
  label: string;
  /** each task's last recorded run: what the pass bar reads */
  tasks: Partial<Record<ScorecardTaskId, TaskScore>>;
  /** plan 51: every recorded run of each task, for the per-task stage comparison; absent before plan 51 */
  runs?: Partial<Record<ScorecardTaskId, TaskScore[]>>;
}

/** A task's recorded runs: its `runs`, else the one row a file written before plan 51 holds. */
export const runsOf = (f: ScorecardFile, t: ScorecardTaskId): TaskScore[] =>
  f.runs?.[t] ?? (f.tasks[t] ? [f.tasks[t] as TaskScore] : []);

/** Spec D17: a stage is compared on at least this many runs of each task. */
export const STAGE_RUNS = 2;

export interface StageRow {
  task: ScorecardTaskId;
  runs: number;
  finished: number;
  /** medians over the task's runs; null where no run recorded the metric */
  wallMin: number | null;
  baselineWallMin: number | null;
  idlePct: number | null;
  concurrency: number | null;
  blockedMin: number | null;
  checkShare: number | null;
  rounds: number | null;
  climbs: number | null;
}

export interface StageVerdict {
  pass: boolean;
  rows: StageRow[];
  failures: string[];
}

const med = (rows: TaskScore[], f: (m: RunMetrics) => number | null): number | null =>
  median(rows.flatMap((r) => (r.metrics ? [f(r.metrics)] : [])).filter((n): n is number => n !== null));

/**
 * Spec D17 (amended): a stage against its baseline, per task and never only in aggregate. Each task needs
 * STAGE_RUNS runs; it fails when one did not finish, or when its median wall time is more than 10 % over the
 * baseline's median for that task. The other metrics are reported, never gated.
 */
export function stageBar(current: ScorecardFile, baseline: ScorecardFile | null): StageVerdict {
  const failures: string[] = [];
  const rows = SCORECARD_TASKS.map((task): StageRow => {
    const runs = runsOf(current, task);
    const base = baseline ? runsOf(baseline, task) : [];
    const wall = median(runs.map((r) => r.wallMinutes));
    const baseWall = median(base.map((r) => r.wallMinutes));
    const finished = runs.filter((r) => r.finished).length;
    if (runs.length < STAGE_RUNS)
      failures.push(`${task}: ${runs.length} run(s); a stage is compared on ${STAGE_RUNS} or more per task`);
    if (finished < runs.length)
      failures.push(`${task}: ${runs.length - finished} of ${runs.length} runs did not finish`);
    if (wall !== null && baseWall !== null && wall > baseWall * (1 + WALL_TOLERANCE))
      failures.push(
        `${task}: median wall ${Math.round(wall)} min against ${baseline?.label}'s ${Math.round(baseWall)} min (more than 10 % slower)`,
      );
    return {
      task,
      runs: runs.length,
      finished,
      wallMin: wall,
      baselineWallMin: baseWall,
      idlePct: med(runs, (m) => m.idlePct),
      concurrency: med(runs, (m) => m.concurrency),
      blockedMin: med(runs, (m) => Object.values(m.blockedMin).reduce((n, x) => n + x, 0)),
      checkShare: med(runs, (m) => m.checkShare),
      rounds: med(runs, (m) => m.rounds.max),
      climbs: med(runs, (m) => m.climbs),
    };
  });
  return { pass: failures.length === 0, rows, failures };
}

export const ScorecardFileSchema = z.looseObject({
  schema: z.literal(1),
  label: z.string(),
  tasks: z.record(z.string(), z.unknown()),
});

const count = z.number().int().min(0);

/** The fields `passBar` and the comparison table read; the rest of a row is carried untouched. */
const TaskScoreRowSchema = z.looseObject({
  catherdVersion: z.string(),
  finished: z.boolean(),
  interventions: z.looseObject({
    parks: count,
    answers: count,
    takeovers: count,
    manualDispatches: count,
    pauses: count,
    superseded: count,
    chat: count,
    total: count,
  }),
  reviewRounds: count,
  wallMinutes: z.number().min(0),
  quota: z.looseObject({
    backends: z.array(z.looseObject({ input: z.number().min(0), output: z.number().min(0) })),
  }),
  firstTry: z.boolean(),
  injected: z.looseObject({ limits: count, standInOk: z.boolean() }).nullable(),
});

/** Checks every row `passBar` consumes; a malformed one fails naming the label, the task and the field. */
export function assertScorecardRows(f: z.infer<typeof ScorecardFileSchema>, file: string): ScorecardFile {
  const runs = Object.entries((f.runs ?? {}) as Record<string, unknown>).flatMap(([task, rows]) =>
    Array.isArray(rows) ? rows.map((row) => [task, row] as const) : [[task, rows] as const],
  );
  for (const [task, row] of [...Object.entries(f.tasks), ...runs]) {
    const r = TaskScoreRowSchema.safeParse(row);
    const issue = r.success ? null : r.error.issues[0];
    const field = issue ? issue.path.join(".") || "row" : null;
    if (!(SCORECARD_TASKS as readonly string[]).includes(task) || issue)
      throw new CatherdError(
        "E_INPUT_INVALID",
        `scorecard ${f.label} (${file}): ${task}: ${field ?? "unknown task"}: ${issue?.message ?? "not one of the four tasks"}`,
        { fix: `fix or delete ${file}, then record the task again` },
      );
  }
  return f as unknown as ScorecardFile;
}

export function assertLabel(label: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{0,40}$/.test(label)) {
    throw new CatherdError("E_INPUT_INVALID", `\`${label}\` is not a scorecard label`, {
      fix: "a version or plan name: 1.5.0, plan-29, 2.0.0-beta.1",
    });
  }
  return label;
}

/** Answers are shown, not added: each one closes a park that is already counted. */
export function interventionTotal(i: Omit<Interventions, "total">): number {
  return (
    i.parks + i.takeovers + i.manualDispatches + i.pauses + i.superseded + i.chat + i.cancels + i.approvals
  );
}

/** The injected task recovered by itself: a limit hit, a stand-in that ended ok, and nobody stepped in. */
export function recovered(s: TaskScore): boolean {
  return (
    s.injected !== null &&
    s.injected.limits > 0 &&
    s.injected.standInOk &&
    s.finished &&
    s.interventions.total === 0
  );
}

export interface Verdict {
  pass: boolean;
  failures: string[];
  /** Facts the reader needs that do not fail the bar. */
  notes: string[];
  wall: { now: number; baseline: number | null };
}

const sumWall = (f: ScorecardFile): number =>
  SCORECARD_TASKS.reduce((n, t) => n + (f.tasks[t]?.wallMinutes ?? 0), 0);

/** The spec's pass bar. Quota, review rounds and the first try are reported, never gated. */
export function passBar(current: ScorecardFile, baseline: ScorecardFile | null): Verdict {
  const failures: string[] = [];
  for (const t of SCORECARD_TASKS) {
    const s = current.tasks[t];
    if (!s) failures.push(`${t}: not recorded`);
    else if (!s.finished) failures.push(`${t}: not finished`);
    else if (s.interventions.total > 0) failures.push(`${t}: ${s.interventions.total} intervention(s)`);
  }
  const injected = current.tasks[INJECTED_TASK];
  if (injected && !recovered(injected)) failures.push(`${INJECTED_TASK}: did not recover by itself`);
  const now = sumWall(current);
  const full = baseline !== null && SCORECARD_TASKS.every((t) => baseline.tasks[t] !== undefined);
  const base = full ? sumWall(baseline) : null;
  const notes = full
    ? SCORECARD_TASKS.filter((t) => baseline.tasks[t]?.finished === false).map(
        (t) =>
          `baseline ${baseline.label}: ${t} did not finish, so its wall-clock stops where it was stopped and the wall-clock bar is lenient`,
      )
    : [];
  if (base === null) failures.push("no full baseline to compare wall-clock against");
  else if (now > base * (1 + WALL_TOLERANCE)) {
    failures.push(
      `wall-clock ${Math.round(now)} min against the baseline's ${Math.round(base)} min (more than 10 % slower)`,
    );
  }
  return { pass: failures.length === 0, failures, notes, wall: { now, baseline: base } };
}

import { z } from "zod";
import { CatherdError } from "./errors.ts";

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
}

export interface ScorecardFile {
  schema: 1;
  label: string;
  tasks: Partial<Record<ScorecardTaskId, TaskScore>>;
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
  for (const [task, row] of Object.entries(f.tasks)) {
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
  return i.parks + i.takeovers + i.manualDispatches + i.pauses + i.superseded + i.chat;
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
  if (base === null) failures.push("no full baseline to compare wall-clock against");
  else if (now > base * (1 + WALL_TOLERANCE)) {
    failures.push(
      `wall-clock ${Math.round(now)} min against the baseline's ${Math.round(base)} min (more than 10 % slower)`,
    );
  }
  return { pass: failures.length === 0, failures, wall: { now, baseline: base } };
}

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { latestOutcomes } from "../domain/route.ts";
import {
  assertLabel,
  SCORECARD_TASKS,
  type ScorecardFile,
  ScorecardFileSchema,
  type ScorecardTask,
  ScorecardTaskSchema,
  type ScorecardTaskId,
  type TaskScore,
} from "../domain/scorecard.ts";
import { assetPath } from "../infra/assets.ts";
import { git, gitHead } from "../infra/git.ts";
import { dataDir } from "../infra/paths.ts";
import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
import { landedMilestones, reviewRounds } from "./milestones.ts";
import { checkEnvFor, runCheck } from "./preflight.ts";
import { runMilestones } from "./protocol.ts";
import { openQuestions } from "./questions.ts";
import {
  findRun,
  listRuns,
  readAgentRuns,
  readOutcomes,
  readRecords,
  type Run,
  supersededBy,
} from "./run-store.ts";
import { failoverRecovered, interventionsOf, pausedMs, runEnd } from "./scorecard-metrics.ts";
import { quotaByBackend } from "./summary.ts";

// Plan 28: prepare a scorecard task's reproducible starting point, score the run that ended there, store the row.

/** The checkout's `scorecard/` folder, or null for an installed package (it ships no fixtures). */
export const scorecardRoot = (): string | null => {
  const root = assetPath("scorecard");
  return existsSync(root) ? root : null;
};

export const defaultPreparedRoot = (): string => join(dataDir(), "scorecard");

const minutes = (ms: number): number => Math.round(ms / 6000) / 10;

export function loadTask(id: string, root: string): ScorecardTask {
  if (!(SCORECARD_TASKS as readonly string[]).includes(id))
    throw new CatherdError("E_INPUT_INVALID", `no scorecard task ${id}`, {
      fix: `catherd scorecard prepare ${SCORECARD_TASKS.join("|")}`,
    });
  const file = join(root, "tasks", id, "task.json");
  const task = readVersioned(file, ScorecardTaskSchema, 1);
  if (task.id !== id)
    throw new CatherdError("E_CONFIG_INVALID", `${file} names task ${task.id}, not ${id}`, {
      fix: `set "id" to ${id} in ${file}`,
    });
  return task;
}

const PreparedSchema = z.looseObject({
  schema: z.literal(1),
  task: z.enum(SCORECARD_TASKS),
  dir: z.string(),
  repo: z.string(),
  plan: z.string(),
  startCommit: z.string(),
  limits: z.string().nullable(),
  shim: z.string().nullable(),
  preparedAt: z.string(),
  prompt: z.string(),
});
export type Prepared = z.infer<typeof PreparedSchema> & { task: ScorecardTaskId };

const GIT_LONG = 30 * 60_000;

/** A git command that must succeed: its failure is `fail`'s error. */
async function must(
  repo: string,
  args: string[],
  fail: () => CatherdError,
  timeoutMs?: number,
): Promise<string> {
  const r = await git(repo, args, timeoutMs);
  if (r.kind !== "ok") throw fail();
  return r.out;
}

export async function prepareTask(i: {
  task: ScorecardTask;
  root: string;
  into: string;
  source?: string;
  now: Date;
  setup: boolean;
}): Promise<Prepared> {
  const { task } = i;
  const src = i.source ?? task.source;
  if (!src)
    throw new CatherdError("E_INPUT_INVALID", `${task.id} names no source`, {
      fix: `catherd scorecard prepare ${task.id} --source <path or URL>`,
    });
  ensurePrivateDir(dirname(i.into));
  try {
    mkdirSync(i.into);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new CatherdError("E_INPUT_INVALID", `${i.into} already exists`, {
        fix: "prepare again: the folder name carries the time",
      });
    throw e;
  }
  // the run's own repo toplevel is the real path; findRun and listRuns key runs by it
  const into = realpathSync(i.into);
  const repo = join(into, "repo");
  const io = (what: string) => () =>
    new CatherdError("E_IO_UNEXPECTED", `${what} failed in ${into}`, {
      fix: `check that git works in ${into}`,
    });
  await must(
    into,
    ["clone", "--quiet", "--no-checkout", src, "repo"],
    () =>
      new CatherdError("E_INPUT_INVALID", `cannot clone ${src}`, {
        fix: `catherd scorecard prepare ${task.id} --source <path or URL>`,
      }),
    GIT_LONG,
  );
  await must(
    repo,
    ["checkout", "--quiet", "-b", `scorecard/${task.id}`, task.commit],
    () =>
      new CatherdError("E_INPUT_INVALID", `${src} has no commit ${task.commit}`, {
        fix: `catherd scorecard prepare ${task.id} --source <a clone that has it>`,
      }),
  );
  await must(repo, ["remote", "remove", "origin"], io("git remote remove"));

  if (task.inject) {
    for (const e of task.inject.edits) {
      const file = join(repo, e.path);
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const parts = text.split(e.find);
      if (parts.length !== 2)
        throw new CatherdError(
          "E_CONFIG_INVALID",
          `${e.path}: the inject text is there ${parts.length - 1} times, not once`,
          {
            fix: `update scorecard/tasks/${task.id}/task.json`,
          },
        );
      writeFileSync(file, parts.join(e.replace));
    }
    await must(repo, ["add", "-A"], io("git add"));
    await must(
      repo,
      [
        "-c",
        "user.name=catherd-scorecard",
        "-c",
        "user.email=scorecard@catherd.invalid",
        "commit",
        "--quiet",
        "-m",
        task.inject.message,
      ],
      io("git commit"),
    );
  }

  let plan: string;
  if ("file" in task.plan) {
    plan = join(into, "plan.md");
    copyFileSync(join(i.root, "tasks", task.id, task.plan.file), plan);
  } else {
    plan = join(repo, task.plan.repoPath);
    if (!existsSync(plan))
      throw new CatherdError("E_CONFIG_INVALID", `${task.plan.repoPath} is not in ${src} at ${task.commit}`, {
        fix: `update scorecard/tasks/${task.id}/task.json`,
      });
  }

  let limits: string | null = null;
  if (task.limits > 0) {
    limits = join(into, "limits");
    mkdirSync(join(limits, "taken"), { recursive: true });
    mkdirSync(join(limits, "tokens"));
    for (let n = 1; n <= task.limits; n++)
      writeFileSync(join(limits, "tokens", String(n)), "", { flag: "w" });
  }

  if (i.setup) {
    const env = await checkEnvFor(repo);
    for (const cmd of task.setup) {
      const r = await runCheck(repo, cmd, GIT_LONG, env);
      if (r.code !== 0 || r.timedOut)
        throw new CatherdError(
          "E_IO_UNEXPECTED",
          `setup \`${cmd}\` failed in ${repo}: ${r.tail.at(-1) ?? "no output"}`,
          {
            fix: `fix it and run it in ${repo}, or prepare again`,
          },
        );
    }
  }

  const startCommit = (await must(repo, ["rev-parse", "HEAD"], io("git rev-parse"))).trim();
  const prepared: Prepared = {
    schema: 1,
    task: task.id,
    dir: into,
    repo,
    plan,
    startCommit,
    limits,
    shim: limits ? join(i.root, "shim") : null,
    preparedAt: i.now.toISOString(),
    prompt: task.prompt.replaceAll("{plan}", () => plan).replaceAll("{acceptance}", () => task.acceptance),
  };
  writeJsonAtomic(join(into, "prepared.json"), prepared);
  return prepared;
}

export function readPrepared(dir: string): Prepared {
  const file = join(dir, "prepared.json");
  if (!existsSync(file))
    throw new CatherdError("E_INPUT_INVALID", `${dir} is not a prepared scorecard task`, {
      fix: `catherd scorecard prepare ${SCORECARD_TASKS.join("|")}`,
    });
  return readVersioned(file, PreparedSchema, 1) as Prepared;
}

/** The one run to score: the named one, else the only open run created in the prepared repo since it was prepared. */
function pickRun(p: Prepared, id: string | undefined): Run {
  if (id) {
    const run = findRun(id);
    if (run.meta.repo !== p.repo)
      throw new CatherdError("E_INPUT_INVALID", `run ${id} belongs to ${run.meta.repo}, not ${p.repo}`, {
        fix: "name a run of the prepared repo, or leave --run out",
      });
    return run;
  }
  const since = Date.parse(p.preparedAt);
  const runs = listRuns([p.repo]).runs.filter(
    (r) => Date.parse(r.meta.createdAt) >= since && !supersededBy(r),
  );
  if (runs.length === 0)
    throw new CatherdError("E_INPUT_INVALID", `no run in ${p.repo} yet`, {
      fix: "run the task's start line, paste its prompt, and record once it has landed or been given up",
    });
  if (runs.length > 1)
    throw new CatherdError("E_INPUT_INVALID", `${p.repo} has runs ${runs.map((r) => r.id).join(", ")}`, {
      fix: `catherd scorecard record ${p.dir} --label <l> --run <id>`,
    });
  return runs[0] as Run;
}

export async function scoreTask(i: {
  dir: string;
  root: string;
  run?: string;
  chat?: number;
  now: number;
}): Promise<TaskScore> {
  const p = readPrepared(i.dir);
  const task = loadTask(p.task, i.root);
  const run = pickRun(p, i.run);
  const milestones = runMilestones(run);
  const landed = landedMilestones(run);
  const finished =
    milestones.length > 0 &&
    milestones.every((m) => landed.includes(m)) &&
    openQuestions(run).length === 0 &&
    !supersededBy(run);
  const end = runEnd(run);
  const start = Date.parse(run.meta.createdAt);

  const copies = task.acceptFiles.map((f) => ({
    from: join(i.root, "tasks", task.id, f.from),
    to: join(p.repo, f.to),
  }));
  for (const c of copies)
    if (existsSync(c.to))
      throw new CatherdError(
        "E_INPUT_INVALID",
        `${c.to.slice(p.repo.length + 1)} already exists in the run's tree`,
        {
          fix: "the run wrote a file the hidden acceptance test needs; rename the file in the run, or score it by hand",
        },
      );
  const done: string[] = [];
  let check: Awaited<ReturnType<typeof runCheck>>;
  const head = await gitHead(p.repo);
  try {
    for (const c of copies) {
      mkdirSync(dirname(c.to), { recursive: true });
      copyFileSync(c.from, c.to);
      done.push(c.to);
    }
    check = await runCheck(
      p.repo,
      task.acceptance,
      task.acceptanceTimeoutMin * 60_000,
      await checkEnvFor(p.repo),
    );
  } finally {
    for (const f of done) rmSync(f, { force: true });
  }
  const acceptance = {
    passed: check.code === 0 && !check.timedOut,
    code: check.code,
    timedOut: check.timedOut,
    tail: check.tail,
  };

  const outcomes = latestOutcomes(readOutcomes(run));
  const takenDir = p.limits ? join(p.limits, "taken") : null;
  return {
    task: task.id,
    run: run.id,
    catherdVersion: run.meta.catherdVersion,
    startCommit: p.startCommit,
    head,
    milestones,
    landed,
    finished,
    interventions: interventionsOf(run, end, i.chat ?? 0),
    reviewRounds: milestones.reduce((n, m) => n + reviewRounds(run, m), 0),
    lanes: {
      total: outcomes.length,
      landed: outcomes.filter((o) => o.landed).length,
      climbs: outcomes.reduce((n, o) => n + o.climbs.length, 0),
    },
    wallMinutes: minutes(end - start),
    pausedMinutes: minutes(pausedMs(run, end)),
    quota: {
      backends: quotaByBackend(readRecords(run).records),
      claudeAgentTokens: readAgentRuns(run).reduce((n, a) => n + a.totalTokens, 0),
    },
    acceptance,
    firstTry: acceptance.passed && finished && new Set(landed).size === landed.length,
    injected:
      task.limits > 0
        ? {
            limits: takenDir && existsSync(takenDir) ? readdirSync(takenDir).length : 0,
            standInOk: failoverRecovered(run),
          }
        : null,
    recordedAt: new Date(i.now).toISOString(),
  };
}

export const resultsFile = (dir: string, label: string): string => join(dir, `${assertLabel(label)}.json`);

export function readScorecard(file: string): ScorecardFile | null {
  return existsSync(file) ? (readVersioned(file, ScorecardFileSchema, 1) as ScorecardFile) : null;
}

/** Sets the task's row in the label's file (a re-record replaces it) and returns the file's contents. */
export function saveTaskScore(file: string, label: string, s: TaskScore): ScorecardFile {
  const f = readScorecard(file) ?? { schema: 1 as const, label, tasks: {} };
  f.tasks[s.task] = s;
  ensurePrivateDir(dirname(file));
  writeJsonAtomic(file, f);
  return f;
}

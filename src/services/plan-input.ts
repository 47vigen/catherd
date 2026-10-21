import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { parseLaneHeader } from "../domain/lane.ts";
import {
  coverageProblems,
  depthProblems,
  type PlanDoc,
  type PlanTask,
  parsePlanDoc,
  planInputNames,
  resolveTask,
} from "../domain/plan-doc.ts";
import type { Role } from "../domain/roles.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { isDaemonRun, replayRun } from "./run-events-store.ts";
import { type Run, runPaths } from "./run-store.ts";

/** The run's copies of the owner's plan files: isolated roles read these, never the originals (plan 32). */
export const PLAN_INPUT_DIR = "plan-input";
/** Past this many characters of preambles, a role's `<context>` names the copies instead of repeating them. */
export const PLAN_CONTEXT_MAX = 100_000;

const invalid = (message: string, fix: string) => new CatherdError("E_INPUT_INVALID", message, { fix });

/** The absolute, deduped plan paths of a `run_start`; a relative one resolves against the repo. */
export function resolvePlanInputs(repo: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(repo, p);
    if (out.includes(abs)) continue;
    if (!existsSync(abs))
      throw invalid(`plan file ${abs} does not exist`, "pass the path of the reviewed plan file");
    if (!statSync(abs).isFile())
      throw invalid(`plan ${abs} is not a file`, "pass the path of the reviewed plan file");
    out.push(abs);
  }
  if (out.length > 0 && !out.some((f) => parsePlanDoc(f, readFileSync(f, "utf8")).tasks.length > 0))
    throw invalid(
      `none of the plan files has a "### Task <n>:" heading: ${out.join(", ")}`,
      "pass the reviewed plan, or no plan and the architect writes one",
    );
  return out;
}

/** The paths of an A-line `plan: a, b` (the label in any case). */
export function planInputPaths(aLines: string[]): string[] {
  return aLines.flatMap((l) =>
    (/^\s*plan:\s*(.*?)\s*$/i.exec(l)?.[1] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
}

/** `<run>/plan-input/<name>`, 0600, for each path; a file that has vanished since keeps its earlier copy. */
export function copyPlanInputs(run: Run, paths: string[]): void {
  const names = planInputNames(paths);
  for (const [i, p] of paths.entries())
    if (existsSync(p))
      writeTextAtomic(join(run.dir, PLAN_INPUT_DIR, names[i] as string), readFileSync(p, "utf8"));
}

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The plan files a role can read, by their path in the run folder: the copies, else plan.md. */
function planFiles(run: Run): { path: string; doc: PlanDoc }[] {
  const plan = replayRun(run).plan;
  const files = plan.length
    ? planInputNames(plan).map((n) => ({ path: `${PLAN_INPUT_DIR}/${n}`, name: n }))
    : [{ path: "plan.md", name: "plan.md" }];
  return files.flatMap((f) => {
    const text = read(join(run.dir, f.path));
    return text === null ? [] : [{ path: f.path, doc: parsePlanDoc(f.name, text) }];
  });
}

/** The run's plan as documents: the copies in `run.started.plan` order; else plan.md; none when neither exists. */
export const planDocs = (run: Run): PlanDoc[] => planFiles(run).map((f) => f.doc);

/** Each plan file's preamble, which applies to every task, for every role but the architect and the judge. */
export function planContext(run: Run, role: Role): string | null {
  if (role === "architect" || role === "judge" || !isDaemonRun(run)) return null;
  const files = planFiles(run);
  const parts = files.flatMap(({ doc }) => {
    if (doc.tasks.length === 0)
      return [`The plan file ${doc.name}, which every task follows:\n\n${doc.text.trim()}`];
    const pre = doc.preamble.trim();
    return pre ? [`The plan's preamble (${doc.name}), which applies to every task:\n\n${pre}`] : [];
  });
  if (parts.length === 0) return null;
  const text = parts.join("\n\n");
  return text.length > PLAN_CONTEXT_MAX
    ? `The run's plan files are too long to repeat here; read them before you start, with read_run_file: ${files.map((f) => f.path).join(", ")}`
    : text;
}

const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/** Every lane file's id, in lane order. */
function laneIds(run: Run): string[] {
  const dir = runPaths(run.dir).lanes;
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort(natural);
}

const laneRefs = (run: Run, lane: string): string[] =>
  parseLaneHeader(read(join(runPaths(run.dir).lanes, `${lane}.md`)) ?? "").tasks;

/** The plan tasks a lane's `Tasks:` line names; a ref that resolves to none is left out (planProblems names it). */
export function laneTasks(run: Run, lane: string): PlanTask[] {
  const docs = planDocs(run);
  return laneRefs(run, lane).flatMap((ref) => {
    const t = resolveTask(docs, ref);
    return typeof t === "string" ? [] : [t];
  });
}

/** A milestone's tasks: those of its lanes in lane order, each once. */
export function milestoneTasks(run: Run, milestone: string): PlanTask[] {
  const seen = new Map<string, PlanTask>();
  for (const id of laneIds(run).filter((l) => l.startsWith(`${milestone}.`)))
    for (const t of laneTasks(run, id)) seen.set(`${t.doc}#${t.id}`, t);
  return [...seen.values()];
}

/**
 * What the architect can fix: a lane that names no task or a missing one, and with no plan input plan.md's depth.
 * A task of the owner's plan with neither a signature nor a test is the owner's, and preflight refuses it.
 */
export function planProblems(run: Run): string[] {
  const docs = planDocs(run);
  const lanes = laneIds(run).map((id) => ({ id, tasks: laneRefs(run, id) }));
  const out = coverageProblems(docs, lanes)
    .filter((p) => p.lane !== "")
    .map((p) => p.note);
  if (replayRun(run).plan.length === 0) out.push(...depthProblems(docs[0] ?? parsePlanDoc("plan.md", "")));
  return out;
}

/** A plan task as a brief carries it: verbatim, in a tag naming its file and number. */
export const taskBlock = (t: PlanTask): string =>
  `<plan-task file="${t.doc}" id="${t.id}">\n${t.text.trimEnd()}\n</plan-task>`;

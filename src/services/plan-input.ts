import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { parseLaneHeader } from "../domain/lane.ts";
import {
  aLineOwner,
  CHECK_COVERED,
  coverageProblems,
  depthProblems,
  milestoneSection,
  type PlanDoc,
  type PlanTask,
  parsePlanDoc,
  planInputNames,
  readsALine,
  resolveTask,
} from "../domain/plan-doc.ts";
import type { Role } from "../domain/roles.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { replayRun } from "./run-events-store.ts";
import { type Run, runPaths } from "./run-store.ts";

/** The run's copies of the owner's plan files: isolated roles read these, never the originals (plan 32). */
export const PLAN_INPUT_DIR = "plan-input";

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

/** The `A<n>` id an A-line starts with (an owner line without one, like `plan: x`, has none). */
export const aLineId = (line: string): string | undefined => /^\s*(A\d+)\b/.exec(line)?.[1];

/** The run's A-lines with their own ids, or positional ids when none has one; plan inputs have none. */
export function numberedALines(lines: string[]): { id: string | undefined; line: string }[] {
  if (lines.some((line) => aLineId(line) !== undefined))
    return lines.map((line) => ({ id: aLineId(line), line }));
  let n = 0;
  return lines.map((line) => {
    if (/^\s*plan:\s*\S/i.test(line)) return { id: undefined, line };
    const id = `A${++n}`;
    return { id, line: `${id} ${line}` };
  });
}

/** The `A<n>` ids plan.md's `## M<n>` section for `milestone` cites: its heading down to the next `## ` heading. */
export function milestoneALines(plan: string, milestone: string): Set<string> {
  const cited = new Set<string>();
  let inside = false;
  for (const line of plan.split("\n")) {
    if (/^##\s/.test(line)) inside = new RegExp(`^##\\s+${milestone}\\b`).test(line);
    if (inside) for (const m of line.matchAll(/\bA\d+\b/g)) cited.add(m[0]);
  }
  return cited;
}

/** The ids a milestone delivers: its cited ids, or every id when the run has only that milestone. */
export function deliveredALines(run: Run, plan: string, m: string): Set<string> {
  const milestones = new Set(laneIds(run).map((id) => id.slice(0, id.indexOf("."))));
  if (milestones.size === 1 && milestones.has(m))
    return new Set(numberedALines(run.meta.aLines).flatMap((a) => (a.id ? [a.id] : [])));
  return milestoneALines(plan, m);
}

/** A plan line's indent and list marker, which an A-line's text does not carry. */
const LIST_MARKER = /^\s*(?:[-*]\s+)?/;

/**
 * The A-lines milestone `m` delivers, in full: the line its section of plan.md gives the id, else the run's own
 * A-line, without its list marker. Whether a Check covers them is the caller's to say (plan 40 D2).
 */
export function deliveredALineTexts(run: Run, m: string): string[] {
  const plan = read(runPaths(run.dir).plan) ?? "";
  const section = (milestoneSection(plan, m) ?? "").split("\n");
  const own = numberedALines(run.meta.aLines);
  return [...deliveredALines(run, plan, m)].flatMap((id) => {
    const line =
      section.find((l) => new RegExp(`${LIST_MARKER.source}${id}\\b`).test(l)) ??
      own.find((a) => a.id === id)?.line;
    return line === undefined ? [] : [line.replace(LIST_MARKER, "")];
  });
}

/**
 * The A-lines milestone `m` delivers that its Check does not cover (plan 40 D2), as `deliveredALineTexts` gives them.
 */
export function uncoveredALines(run: Run, m: string): string[] {
  return deliveredALineTexts(run, m).filter((text) => !CHECK_COVERED.test(text));
}

/** The run's A<n> lines that no laned milestone's section of plan.md cites: nothing ties a landed commit to them. */
function unownedALines(run: Run): string[] {
  // no plan.md owns nothing; a milestone section with no lane never runs, so it owns nothing either
  const plan = read(runPaths(run.dir).plan) ?? "";
  const milestones = new Set(laneIds(run).map((id) => id.slice(0, id.indexOf("."))));
  const owned = new Set(plan ? [...milestones].flatMap((m) => [...deliveredALines(run, plan, m)]) : []);
  return numberedALines(run.meta.aLines).flatMap(({ id }) => {
    return id && !owned.has(id) ? [id] : [];
  });
}

/** The ids of plan.md's A-lines under its `## M<n>` sections that carry no owner tag (plan 44 D4). */
function untaggedALines(plan: string): string[] {
  const ids = new Set<string>();
  let inside = false;
  for (const line of plan.split("\n")) {
    if (/^##\s/.test(line)) inside = /^##\s+M\d+\b/.test(line);
    const id = /^\s*(?:[-*]\s+)?(A\d+)\b/.exec(line)?.[1];
    if (inside && id && aLineOwner(line) === null) ids.add(id);
  }
  return [...ids];
}

/**
 * What the architect can fix: a lane that names no task or a missing one, an A-line no milestone owns, and with
 * no plan input plan.md's depth. A task of the owner's plan with neither a signature nor a test is the owner's,
 * and preflight refuses it.
 */
export function planProblems(run: Run): string[] {
  const docs = planDocs(run);
  const lanes = laneIds(run).map((id) => ({ id, tasks: laneRefs(run, id) }));
  const out = coverageProblems(docs, lanes)
    .filter((p) => p.lane !== "")
    .map((p) => p.note);
  for (const id of untaggedALines(read(runPaths(run.dir).plan) ?? ""))
    out.push(`${id} in plan.md has no owner tag: write it ${id} [worker|reviewer|verifier|run]`);
  const unowned = unownedALines(run);
  if (unowned.length)
    out.push(
      `${unowned.join(", ")} ${unowned.length > 1 ? "are" : "is"} cited under no milestone: under the milestone that delivers each, write it in plan.md as an A<n> line`,
    );
  if (replayRun(run).plan.length === 0) out.push(...depthProblems(docs[0] ?? parsePlanDoc("plan.md", "")));
  return out;
}

/** A plan task as a brief carries it: verbatim, in a tag naming its file and number. */
export const taskBlock = (t: PlanTask): string =>
  `<plan-task file="${t.doc}" id="${t.id}">\n${t.text.trimEnd()}\n</plan-task>`;

/** Past this many characters the unit context names a plan file instead of repeating it (plan 44 D6). */
export const UNIT_CONTEXT_MAX = 20_000;

/** `§3.2` is the `###` subsection headed `3.2`; `§3` the `##` section's own text, down to its first `###`. */
function sectionOf(text: string, ref: string): string | null {
  const level = ref.split(".").length + 1;
  const lines = text.split("\n");
  const head = new RegExp(`^#{${level}}[ \\t]+(?:§)?${ref.replaceAll(".", "\\.")}(?!\\.?\\d)`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return null;
  const stop = new RegExp(`^#{1,${Math.max(level, 3)}}[ \\t]`);
  const end = lines.findIndex((l, i) => i > at && stop.test(l));
  return lines
    .slice(at, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** The milestone a unit (`M1.L2`, `M1`) belongs to; the run unit and any other name have none. */
const unitMilestone = (unit: string): string | null => /^(M\d+)(?:\.|$)/.exec(unit)?.[1] ?? null;

/**
 * The A-lines `role` reads for `unit`: its milestone's lines whose owner tag it reads (plan 44 D4); every line of
 * the run for the run unit.
 */
export function roleALines(run: Run, role: Role, unit: string): string[] {
  const m = unitMilestone(unit);
  if (m === null) return numberedALines(run.meta.aLines).flatMap((a) => (a.id ? [a.line] : []));
  return deliveredALineTexts(run, m).filter((l) => readsALine(role, aLineOwner(l)));
}

/**
 * Part 3 of a brief minus the lane file (plan 44 D6): the unit's plan tasks verbatim, the sections they cite
 * (`§n` resolves in the task's own file, else in the taskless plan file its line names), the role's A-lines, and the
 * paths of the other plan files. Past `UNIT_CONTEXT_MAX` the cited sections are cut and the file named.
 */
export function unitContext(run: Run, role: Role, unit: string): string[] {
  const m = unitMilestone(unit);
  const tasks = m === null ? [] : unit.includes(".") ? laneTasks(run, unit) : milestoneTasks(run, m);
  const files = planFiles(run);
  const cited = new Map<string, Map<string, string>>(); // path → ref → section
  for (const t of tasks)
    for (const line of t.text.split("\n"))
      for (const [, ref = ""] of line.matchAll(/§(\d+(?:\.\d+)*)/g))
        for (const f of [
          files.find((f) => f.doc.name === t.doc),
          ...files.filter((f) => f.doc.tasks.length === 0 && line.includes(f.doc.name)),
        ]) {
          const section = f && sectionOf(f.doc.text, ref);
          if (!f || !section) continue;
          const held = cited.get(f.path) ?? new Map<string, string>();
          held.set(ref, section);
          cited.set(f.path, held);
          break;
        }
  const lines = roleALines(run, role, unit);
  const own = new Set(tasks.map((t) => t.doc));
  const others = files.filter((f) => !own.has(f.doc.name)).map((f) => `- ${f.path}`);
  const head = tasks.map(taskBlock);
  const tail = [
    ...(lines.length ? [`Your A-lines:\n${lines.join("\n")}`] : []),
    ...(others.length ? [`Read on demand:\n${others.join("\n")}`] : []),
  ];
  // each block costs its length and a blank line between it and the next
  let room = UNIT_CONTEXT_MAX - [...head, ...tail].reduce((n, b) => n + b.length + 2, 0);
  const middle = [...cited].map(([path, sections]) => {
    const body = `Cited from ${path}:\n\n${[...sections.values()].join("\n\n")}`;
    if (body.length + 2 <= room) {
      room -= body.length + 2;
      return body;
    }
    const pointer = `[… cut: read ${path} with catherd run-file read]`;
    const kept = body.slice(0, Math.max(room - pointer.length - 3, 0));
    room = 0;
    return kept ? `${kept}\n${pointer}` : pointer;
  });
  return [...head, ...middle, ...tail];
}

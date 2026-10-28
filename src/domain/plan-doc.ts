/** Plan files as a preamble and tasks (plan 32): what a lane's `Tasks:` line points at, and what an approval reads. */

import type { Role } from "./roles.ts";
import { maskFences } from "./util.ts";

export interface PlanTask {
  doc: string;
  id: string;
  title: string;
  text: string;
  signature: boolean;
  test: boolean;
}
export interface PlanDoc {
  name: string;
  preamble: string;
  tasks: PlanTask[];
  /** the whole file, for the section checks (a section may follow the tasks) */
  text: string;
}

export const TASK_HEADING = /^#{2,4}[ \t]+Task[ \t]+(\d+(?:\.\d+)*[a-z]?)\b[ \t]*[:.—–-]?[ \t]*(.*)$/gim;
export const TASK_REF = /^(?:([^\s#,]+)#)?(\d+(?:\.\d+)*[a-z]?)$/;
/** An A-line the milestone's Check covers: it ends `(Check)`, a trailing `.` allowed. */
export const CHECK_COVERED = /\(Check\)\s*\.?\s*$/i;

/**
 * An A-line about the work itself, not the product: the run's own commits, test-first evidence, or file scope.
 * Judged by no gate (plan 45). Anchored to process wording, so "the panel shows the commit message" stays a product line.
 */
export const PROCESS_LINE =
  /\b(?:the|each|its|this) (?:lane|task|milestone)'s commits?\b|\bcommit (?:subject|message|title|history)s?(?= (?:is|are|must|should|reads?)\b)|\bin its own commit\b|\balone in (?:its|a) commit\b|\bred evidence\b|\bred (?:run|test)s? (?:first|before the code)\b|\bfailed before(?= (?:the|its) (?:code|implementation)\b)|\bTDD\b|\btests? (?:written )?first\b|\b(?:diff|lane|milestone)\b[^.]{0,40}?\b(?:must|may|should) not (?:touch|change|modify|edit)\b|\b(?:touch(?:es)?|changes|modifies) only (?:the )?files\b/i;

export const A_LINE_OWNERS = ["worker", "reviewer", "verifier", "run"] as const;
export type ALineOwner = (typeof A_LINE_OWNERS)[number];

/** The owner tag of an A-line, `A3 [verifier] — …` → `verifier`; an untagged or unknown tag is null (it reads as `run`). */
export function aLineOwner(line: string): ALineOwner | null {
  const tag = /^\s*(?:[-*]\s+)?A\d+\s+\[([^\]]*)\]/.exec(line)?.[1];
  return (A_LINE_OWNERS as readonly string[]).includes(tag ?? "") ? (tag as ALineOwner) : null;
}

const OWNER_ROLES: Record<ALineOwner, readonly Role[]> = {
  worker: ["worker", "writer", "artist", "researcher"],
  reviewer: ["reviewer", "ui-reviewer"],
  verifier: ["verifier"],
  run: [],
};

/** Whether `role` reads an A-line of `owner`: its own group's, the `run` ones and untagged ones; the architect reads all. */
export function readsALine(role: Role, owner: ALineOwner | null): boolean {
  return owner === null || owner === "run" || role === "architect" || OWNER_ROLES[owner].includes(role);
}

const SIGNATURE = [
  /^[ \t]*(?:[-*][ \t]*)?\**(?:Interfaces|Produces|Signatures?)\**[ \t]*:/im,
  /^[ \t]*```/m,
  /`[^`\n]*\w\([^`\n]*\)[^`\n]*`/,
];
const TEST = [
  /^[ \t]*(?:[-*][ \t]*)?\**Tests?\**[ \t]*:/im,
  /[\w./-]*(?:\.test\.|_test\.|\.spec\.|\btest_)[\w.]*/,
  /\b(?:it|test|describe)\(\s*["'`]|\bfunc Test\w+|\bdef test_\w+|#\[test\]/,
  /^[ \t]*(?:[-*][ \t]*)?\**Expected\**[ \t]*:/im,
];

/** Where the first `## M<n>` heading starts; the text's end when it has none. */
const milestoneStart = (text: string): number => /^##[ \t]+M\d+\b/m.exec(text)?.index ?? text.length;

export function parsePlanDoc(name: string, text: string): PlanDoc {
  // headings are matched with fenced code blanked, so a `## ` line in a code block ends nothing
  const masked = maskFences(text);
  const heads = [...masked.matchAll(TASK_HEADING)];
  const tasks: PlanTask[] = heads.map((m, i) => {
    const next = heads[i + 1]?.index ?? text.length;
    const body = text.slice(m.index, next);
    const nl = body.indexOf("\n");
    // a task ends at the next task heading, or at the next `## ` heading after its own line
    const rest = nl < 0 ? -1 : masked.slice(m.index + nl, next).search(/^##[ \t]+(?!#)/m);
    const taskText = rest < 0 ? body : body.slice(0, nl + rest);
    return {
      doc: name,
      id: m[1] as string,
      title: (m[2] ?? "").trim(),
      text: taskText,
      signature: SIGNATURE.some((r) => r.test(taskText)),
      test: TEST.some((r) => r.test(taskText)),
    };
  });
  const milestone = milestoneStart(masked);
  return { name, preamble: text.slice(0, Math.min(milestone, heads[0]?.index ?? text.length)), tasks, text };
}

const and = (names: string[]) =>
  names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The task a lane's `Tasks:` ref names, or why it names none. */
export function resolveTask(docs: PlanDoc[], ref: string): PlanTask | string {
  const m = TASK_REF.exec(ref);
  if (!m) return `${ref} is not a task number like 3 or plan.md#3`;
  const file = m[1];
  const id = m[2] as string;
  if (file !== undefined) {
    const doc = docs.find((d) => d.name === file);
    if (!doc) return `no plan file ${file}`;
    return pick(doc, id) ?? `no task ${id} in ${file}`;
  }
  const owners = docs.filter((d) => d.tasks.some((t) => t.id === id));
  if (owners.length === 0) return `no task ${id} in ${docs.map((d) => d.name).join(", ")}`;
  if (owners.length > 1) {
    const names = owners.map((d) => d.name);
    return `task ${id} is in ${and(names)}: write ${names[0]}#${id}`;
  }
  return pick(owners[0] as PlanDoc, id) as PlanTask | string;
}

/** The one task `id` names in `doc`, or why it names none: a file that holds a number twice cannot say which. */
function pick(doc: PlanDoc, id: string): PlanTask | string | undefined {
  const held = doc.tasks.filter((t) => t.id === id);
  return held.length > 1 ? `${doc.name} holds Task ${id} twice: renumber one of them` : held[0];
}

export const DEPTH_SECTIONS = ["What already exists", "Contracts", "Decisions"] as const;

/** The text under a `## <name>` heading (case-insensitive prefix), up to the next `## ` heading; null when absent. */
function section(text: string, name: string): string | null {
  const lines = text.split("\n");
  const heads = maskFences(text).split("\n");
  const at = heads.findIndex((l) => new RegExp(`^##[ \\t]+${name}`, "i").test(l));
  if (at < 0) return null;
  const end = heads.findIndex((l, i) => i > at && /^##[ \t]+(?!#)/.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
}

const DECISION = /^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]*)?\**(D\d+)\b/;

/** What a plan the architect wrote lacks, to the depth the owner reviews: one line per gap. */
export function depthProblems(doc: PlanDoc): string[] {
  const out: string[] = [];
  const full = doc.text;
  for (const s of DEPTH_SECTIONS) if (section(full, s) === null) out.push(`plan.md has no "## ${s}" section`);
  for (const [id, text] of decisionLines(full)) {
    if (!/rejected/i.test(text))
      out.push(
        `plan.md ${id} names no rejected alternative: write ${id} — <choice> — rejected: <alternative> — <why>`,
      );
  }
  const exists = section(full, "What already exists");
  if (exists !== null && !/`[^`\n]*(?:\/|\.\w+)[^`\n]*`/.test(exists))
    out.push("plan.md's What already exists lists no path");
  return out;
}

export const APPROVE_WORDS = ["approve", "approved", "yes", "ok", "lgtm"] as const;

/** A bare approving word, case and a trailing `.`/`!` ignored; "ok but rename X" is a change request. */
export function isApproval(answer: string): boolean {
  const w = answer
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  return (APPROVE_WORDS as readonly string[]).includes(w);
}

/** An owner answer that waives: its first word is `accept`, any case ("accept: A8 is judged from the tree"). */
export function isAccept(answer: string): boolean {
  return /^accept\b/i.test(answer.trim());
}

export const approvalQuestion = (runId: string) =>
  `The architect's plan is ready for your review: catherd run-file read ${runId} plan.md. Answer approve, or say what to change.`;

/** Each decision of the Decisions section, keyed by its id: its `D<n>` line and the lines under it up to the next `D<n>` line, a blank line or a heading, whitespace collapsed. */
export function decisionLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let id: string | undefined;
  for (const line of (section(text, "Decisions") ?? "").split("\n")) {
    const next = DECISION.exec(line)?.[1];
    if (next) out.set((id = next), line.trim());
    else if (!line.trim() || /^\s*#/.test(line)) id = undefined;
    else if (id) out.set(id, `${out.get(id)} ${line.trim()}`);
  }
  for (const [k, v] of out) out.set(k, v.replace(/\s+/g, " "));
  return out;
}

/** The copies' file names: basenames, a repeat numbered `-2` before its extension. */
export function planInputNames(paths: string[]): string[] {
  const used = new Set<string>();
  return paths.map((p) => {
    const base = p.split("/").at(-1) as string;
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${stem}-${n}${ext}`;
    used.add(name);
    return name;
  });
}

/** One milestone's section: its `## <id>` line up to the next `## ` heading, or null when the plan has none. */
export function milestoneSection(planText: string, id: string): string | null {
  const lines = planText.split("\n");
  const heads = maskFences(planText).split("\n");
  const at = heads.findIndex((line) => /^##[ \t]+(M\d+)\b/.exec(line)?.[1] === id);
  if (at < 0) return null;
  const end = heads.findIndex((line, i) => i > at && /^##[ \t]+/.test(line));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

/** The Check command of one milestone section, or null when absent. */
export function milestoneCheck(planText: string, id: string): string | null {
  for (const line of maskFences(milestoneSection(planText, id) ?? "").split("\n")) {
    const check = /^[ \t]*Check:[ \t]*(.+)/.exec(line)?.[1]?.trim();
    if (check) return check;
  }
  return null;
}

/** The `Baseline:` items of one milestone's section and of the preamble above the first milestone, in plan order. */
export function baselineItems(planText: string, id: string): string[] {
  const preamble = planText.slice(0, milestoneStart(maskFences(planText)));
  const out: string[] = [];
  for (const line of [...preamble.split("\n"), ...(milestoneSection(planText, id) ?? "").split("\n")]) {
    const item = /^[ \t]*Baseline:[ \t]*(.+)/.exec(line)?.[1]?.trim();
    if (item) out.push(item);
  }
  return out;
}

/** The `Format:` command of one milestone: its section's last such line, else the preamble's; null when neither has one. */
export function formatCommand(planText: string, id: string): string | null {
  const preamble = planText.slice(0, milestoneStart(maskFences(planText)));
  for (const text of [milestoneSection(planText, id) ?? "", preamble]) {
    const found = [...text.matchAll(/^[ \t]*Format:[ \t]*(.+)$/gm)].map((m) => m[1]?.trim()).at(-1);
    if (found) return found;
  }
  return null;
}

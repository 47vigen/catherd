/** Plan files as a preamble and tasks (plan 32): what a lane's `Tasks:` line points at, and what an approval reads. */

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

export const TASK_HEADING = /^#{2,4}[ \t]+Task[ \t]+(\d+[a-z]?)\b[ \t]*[:.—–-]?[ \t]*(.*)$/gim;
export const TASK_REF = /^(?:([^\s#,]+)#)?(\d+[a-z]?)$/;

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

export function parsePlanDoc(name: string, text: string): PlanDoc {
  const heads = [...text.matchAll(TASK_HEADING)];
  const tasks: PlanTask[] = heads.map((m, i) => {
    const next = heads[i + 1]?.index ?? text.length;
    const body = text.slice(m.index, next);
    const nl = body.indexOf("\n");
    // a task ends at the next task heading, or at the next `## ` heading after its own line
    const rest = nl < 0 ? -1 : body.slice(nl).search(/^##[ \t]+(?!#)/m);
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
  const milestone = /^##[ \t]+M\d+\b/m.exec(text)?.index ?? text.length;
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

/** What is wrong between a milestone's lanes and the plan: a lane with no task, a bad ref, a task with nothing to build or test. */
export function coverageProblems(
  docs: PlanDoc[],
  lanes: { id: string; tasks: string[] }[],
): { lane: string; note: string }[] {
  const out: { lane: string; note: string }[] = [];
  const named = new Set<PlanTask>();
  for (const l of lanes) {
    if (l.tasks.length === 0) {
      out.push({
        lane: l.id,
        note: `lanes/${l.id}.md has no Tasks: line: name the plan tasks it implements`,
      });
      continue;
    }
    for (const ref of l.tasks) {
      const r = resolveTask(docs, ref);
      if (typeof r === "string") out.push({ lane: l.id, note: `lanes/${l.id}.md: Tasks: ${ref} — ${r}` });
      else named.add(r);
    }
  }
  // only a task a lane builds needs something to build or test: the rest of the plan is the owner's
  for (const t of named)
    if (!t.signature && !t.test)
      out.push({
        lane: "",
        note: `${t.doc} Task ${t.id} has neither a signature nor a test: add its signatures (a code block or an Interfaces: line) or a Test: line`,
      });
  return out;
}

export const DEPTH_SECTIONS = ["What already exists", "Contracts", "Decisions"] as const;

/** The text under a `## <name>` heading (case-insensitive prefix), up to the next `## ` heading; null when absent. */
function section(text: string, name: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^##[ \\t]+${name}`, "i").test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^##[ \t]+(?!#)/.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
}

const DECISION = /^[ \t]*(?:(?:[-*]|\d+[.)])[ \t]*)?\**(D\d+)\b/;

/** What a plan the architect wrote lacks, to the depth the owner reviews: one line per gap. */
export function depthProblems(doc: PlanDoc): string[] {
  const out: string[] = [];
  const full = doc.text;
  for (const s of DEPTH_SECTIONS) if (section(full, s) === null) out.push(`plan.md has no "## ${s}" section`);
  if (doc.tasks.length === 0) out.push('plan.md has no "### Task <n>:" heading');
  for (const t of doc.tasks)
    if (!t.test) out.push(`plan.md Task ${t.id} has no test: add a Test: line naming its test file and case`);
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

export const approvalQuestion = (runId: string) =>
  `The architect's plan is ready for your review: catherd run-file read ${runId} plan.md. Answer approve, or say what to change.`;

export const reapprovalQuestion = (runId: string, ids: string[]) =>
  `The architect changed approved decisions ${ids.join(", ")} of plan.md: catherd run-file read ${runId} plan.md. Answer approve, or say what to change.`;

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

/** The `D<n>` ids added, removed or edited between two plan texts, in number order. */
export function changedDecisions(approved: string, now: string): string[] {
  const a = decisionLines(approved);
  const b = decisionLines(now);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((id) => a.get(id) !== b.get(id))
    .sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
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

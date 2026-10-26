import { checkItems } from "./fail-lines.ts";
import { type LaneHeader, parseLaneHeader } from "./lane.ts";
import { milestoneCheck, milestoneSection } from "./plan-doc.ts";

export interface PlanLint {
  /** advice only: preflight reports it and goes on */
  warnings: string[];
  /** an `After:` that can never finish: the lane (or the cycle's first lane) never starts */
  stuck: { lane: string; note: string }[];
}

const milestoneOf = (id: string): string => id.split(".")[0] as string;
const isFolder = (p: string): boolean => p.endsWith("/");

/**
 * Lint of the lanes in scope. `known` is every lane id of the run (a bare milestone `Mx` is known when one of its lanes is), the landed milestones' too, so an `After:` on a
 * lane that already landed is no error. `finished` is the milestones that landed (merged, in a base run): an `After:`
 * on a lane of any other milestone can never finish, as that milestone does not start before this one is done. Never throws: a lane whose header cannot be read is left out.
 */
export function lintLanes(
  lanes: { id: string; text: string }[],
  known: string[],
  finished: string[] = [],
): PlanLint {
  const warnings: string[] = [];
  const stuck: PlanLint["stuck"] = [];
  const headers = new Map<string, LaneHeader>();
  for (const l of lanes) {
    try {
      headers.set(l.id, parseLaneHeader(l.text));
    } catch {
      // a header that cannot be read is preflight's refusal to make, not lint's
    }
  }
  const inScope = lanes.filter((l) => headers.has(l.id));
  const milestones = new Set(known.map(milestoneOf));

  for (const { id } of inScope) {
    const h = headers.get(id) as LaneHeader;
    const folders = h.owns.filter(isFolder);
    if (folders.length)
      warnings.push(
        `${id}: Owns names whole folders (${folders.join(", ")}): name the files, unless the lane creates the folder`,
      );
    for (const a of h.after) {
      if (a === id) stuck.push({ lane: id, note: `${id}: After: names the lane itself` });
      else if (!a.includes(".") && a === milestoneOf(id))
        stuck.push({ lane: id, note: `${id}: After: ${a} is its own milestone: this lane never starts` });
      else if (a.includes(".") ? !known.includes(a) : !milestones.has(a))
        stuck.push({ lane: id, note: `${id}: After: ${a} has no lane file` });
      else if (milestoneOf(a) !== milestoneOf(id) && !finished.includes(milestoneOf(a)))
        stuck.push({
          lane: id,
          note: `${id}: After: ${a} is in milestone ${milestoneOf(a)}, which has not finished: this lane never starts`,
        });
      else {
        const other = headers.get(a);
        if (
          other &&
          h.kind !== "research" &&
          other.kind !== "research" &&
          h.owns.length &&
          other.owns.length &&
          !h.owns.some(isFolder) &&
          !other.owns.some(isFolder) &&
          !h.owns.some((p) => other.owns.includes(p))
        )
          warnings.push(
            `${id}: After: ${a} shares no file with it: drop it unless ${id} needs ${a}'s output`,
          );
      }
    }
  }

  const edges = (id: string): string[] =>
    (headers.get(id)?.after ?? []).filter((a) => a !== id && headers.has(a));

  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): void => {
    state.set(id, "visiting");
    path.push(id);
    for (const a of edges(id)) {
      if (state.get(a) === "visiting") {
        const loop = [...path.slice(path.indexOf(a)), a];
        stuck.push({ lane: a, note: `After: cycle ${loop.join(" → ")}: these lanes never start` });
      } else if (!state.has(a)) visit(a);
    }
    path.pop();
    state.set(id, "done");
  };
  for (const { id } of inScope) if (!state.has(id)) visit(id);

  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const seen = depth.get(id);
    if (seen !== undefined) return seen;
    depth.set(id, 1);
    const d =
      1 +
      Math.max(
        0,
        ...edges(id)
          .filter((a) => milestoneOf(a) === milestoneOf(id))
          .map(depthOf),
      );
    depth.set(id, d);
    return d;
  };
  const byMilestone = new Map<string, string[]>();
  for (const { id } of inScope)
    byMilestone.set(milestoneOf(id), [...(byMilestone.get(milestoneOf(id)) ?? []), id]);
  for (const [m, ids] of byMilestone) {
    if (ids.length < 2 || !ids.some((id) => edges(id).some((a) => milestoneOf(a) === m))) continue;
    const k = Math.max(...ids.map(depthOf));
    warnings.push(
      `info: ${m} critical path ${k} of ${ids.length} lanes${k === ids.length ? ": fully serial" : ""}`,
    );
  }
  return { warnings, stuck };
}

/** What keeps the milestones from ever starting: an `after` naming no milestone of the plan, or a wait cycle. */
export function milestoneProblems(milestones: { id: string; after: string[] }[]): string[] {
  const after = new Map(milestones.map((m) => [m.id, m.after]));
  const out: string[] = [];
  for (const m of milestones)
    for (const a of m.after) if (!after.has(a)) out.push(`${m.id}: After: ${a} is no milestone of the plan`);
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    path.push(id);
    for (const a of after.get(id) ?? []) {
      if (path.includes(a))
        out.push(`milestones wait on each other (cycle ${[...path.slice(path.indexOf(a)), a].join(" → ")})`);
      else if (!done.has(a) && after.has(a)) visit(a);
    }
    path.pop();
    done.add(id);
  };
  for (const m of milestones) if (!done.has(m.id)) visit(m.id);
  return out;
}

/** Words that ask for commit history, which catherd cannot show: it commits tests and code together. */
const HISTORY =
  /before (?:the|its) code|red before|failed before|in its own commit|alone in (?:its|a) commit|TDD|commit history/i;
/** A check item that is a shell loop: `do` and `done` in it. */
const LOOP = /\bdo\b[\s\S]*\bdone\b/;

/** The Check's items, or the whole Check when it does not split (checkItems throws on an empty part). */
const itemsOf = (check: string): string[] => {
  try {
    return checkItems(check);
  } catch {
    return [check];
  }
};

/**
 * The plan's advice on one milestone: no Check, a Check item that is a shell loop, an A-line about commit history.
 * `aLines` are the run's own A-lines. Preflight reports it and never refuses on it.
 */
export function lintPlan(planText: string, milestone: string, aLines: string[]): string[] {
  const warnings: string[] = [];
  const check = milestoneCheck(planText, milestone);
  if (check === null)
    warnings.push(`${milestone}: no Check: line: the verifier must run the whole gate by hand`);
  for (const item of check === null ? [] : itemsOf(check))
    if (LOOP.test(item))
      warnings.push(
        `${milestone}: Check item \`${item}\` is a shell loop: one 30-minute budget for every package; write one item per package`,
      );
  for (const line of [...(milestoneSection(planText, milestone) ?? "").split("\n"), ...aLines]) {
    const id = /^\s*(?:[-*]\s+)?(A\d+)\b/.exec(line)?.[1];
    const words = HISTORY.exec(line)?.[0];
    if (id && words)
      warnings.push(
        `${milestone}: ${id} asks for commit history (${words}): catherd commits tests and code together; it is judged from the tree`,
      );
  }
  return warnings;
}

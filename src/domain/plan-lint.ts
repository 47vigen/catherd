import { type LaneHeader, parseLaneHeader } from "./lane.ts";

export interface PlanLint {
  /** advice only: preflight reports it and goes on */
  warnings: string[];
  /** an `After:` that can never finish: the lane (or the cycle's first lane) never starts */
  stuck: { lane: string; note: string }[];
}

const milestoneOf = (id: string): string => id.split(".")[0] as string;
const isFolder = (p: string): boolean => p.endsWith("/");

/**
 * Lint of the lanes in scope. `known` is every lane id of the run, the landed milestones' too, so an `After:` on a
 * lane that already landed is no error. Never throws: a lane whose header cannot be read is left out.
 */
export function lintLanes(lanes: { id: string; text: string }[], known: string[]): PlanLint {
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

  for (const { id } of inScope) {
    const h = headers.get(id) as LaneHeader;
    const folders = h.owns.filter(isFolder);
    if (folders.length)
      warnings.push(
        `${id}: Owns names whole folders (${folders.join(", ")}): name the files, unless the lane creates the folder`,
      );
    for (const a of h.after) {
      if (a === id) stuck.push({ lane: id, note: `${id}: After: names the lane itself` });
      else if (!known.includes(a)) stuck.push({ lane: id, note: `${id}: After: ${a} has no lane file` });
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

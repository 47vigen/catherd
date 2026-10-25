import type { MilestonePlan } from "./run-events.ts";

/**
 * Each not-done lane's slack in the remaining plan: the longest path through the whole DAG minus the longest path
 * through the lane. Nodes: every lane of a milestone not in `done` (weight 1) and one gate per such milestone
 * (weight 1: its review, verify and land). Edges: lane → its milestone's gate; a lane's `After:` on a lane of its own
 * milestone → that lane; any other `After:` entry, and every milestone `after`, → the dependency's gate (dropped when
 * the dependency is done). Unknown ids are ignored; a cycle gives an empty map.
 */
export function laneSlack(plan: readonly MilestonePlan[], done: ReadonlySet<string>): Map<string, number> {
  const open = plan.filter((m) => !done.has(m.id));
  const gateOf = new Map(open.map((m) => [m.id, `gate:${m.id}`]));
  const milestoneOfLane = new Map(plan.flatMap((m) => m.lanes.map((l) => [l.id, m.id] as const)));
  const preds = new Map<string, Set<string>>();
  const node = (k: string) => preds.get(k) ?? preds.set(k, new Set()).get(k)!;
  for (const m of open) {
    const gate = gateOf.get(m.id)!;
    node(gate);
    for (const d of m.after) {
      const dep = gateOf.get(d);
      if (dep !== undefined && d !== m.id) node(gate).add(dep);
    }
    for (const l of m.lanes) {
      node(l.id);
      node(gate).add(l.id);
      for (const d of m.after) {
        const dep = gateOf.get(d);
        if (dep !== undefined && d !== m.id) node(l.id).add(dep);
      }
      for (const a of l.after) {
        const owner = milestoneOfLane.get(a) ?? (gateOf.has(a) ? a : undefined);
        if (owner === m.id) {
          if (a !== m.id && a !== l.id) node(l.id).add(a);
        } else if (owner !== undefined && gateOf.has(owner)) node(l.id).add(gateOf.get(owner)!);
      }
    }
  }
  // Longest path ending at each node (up) in topological order, then starting at it (down) in reverse.
  const succs = new Map([...preds.keys()].map((k) => [k, [] as string[]]));
  const indeg = new Map<string, number>();
  for (const [k, ps] of preds) {
    indeg.set(k, ps.size);
    for (const p of ps) succs.get(p)!.push(k);
  }
  const order = [...preds.keys()].filter((k) => indeg.get(k) === 0);
  for (let i = 0; i < order.length; i++)
    for (const s of succs.get(order[i]!)!) {
      const n = indeg.get(s)! - 1;
      indeg.set(s, n);
      if (n === 0) order.push(s);
    }
  if (order.length !== preds.size) return new Map();
  const up = new Map<string, number>();
  for (const k of order) up.set(k, 1 + Math.max(0, ...[...preds.get(k)!].map((p) => up.get(p)!)));
  const down = new Map<string, number>();
  for (const k of order.toReversed()) down.set(k, 1 + Math.max(0, ...succs.get(k)!.map((s) => down.get(s)!)));
  const longest = Math.max(0, ...up.values());
  const out = new Map<string, number>();
  for (const m of open)
    for (const l of m.lanes) out.set(l.id, longest - (up.get(l.id)! + down.get(l.id)! - 1));
  return out;
}

import type { Attempt, RunModel, RunModelPatch } from "../../../../client";

/**
 * Folds one socket patch into the model held: changed nodes are replaced by id (new ones join the end), removed ones
 * are dropped, edges are replaced unless null. The dispatch list follows the patched nodes' dispatch attempts.
 * A patch no newer than the model changes nothing, so a replayed frame is harmless.
 * shortcut: a new dispatch that sits on no node joins the list only on the next full read (a reconnect).
 */
export function applyPatch(model: RunModel, patch: RunModelPatch): RunModel {
  if (patch.seq <= model.seq) return model;
  const changed = new Map(patch.nodes.map((n) => [n.id, n]));
  const removed = new Set(patch.removed);
  const nodes = model.nodes.filter((n) => !removed.has(n.id)).map((n) => changed.get(n.id) ?? n);
  const held = new Set(nodes.map((n) => n.id));
  nodes.push(...patch.nodes.filter((n) => !held.has(n.id)));

  const fresh = new Map<string, Attempt>();
  for (const n of patch.nodes) for (const a of n.attempts) if (a.kind === "dispatch") fresh.set(a.id, a);
  const dispatches = model.dispatches.map((d) => fresh.get(d.id) ?? d);
  const known = new Set(dispatches.map((d) => d.id));
  const added = [...fresh.values()].filter((a) => !known.has(a.id)).sort((a, b) => b.at.localeCompare(a.at));

  return {
    ...model,
    seq: patch.seq,
    phase: patch.phase,
    outcome: patch.outcome,
    nodes,
    edges: patch.edges ?? model.edges,
    dispatches: [...added, ...dispatches],
  };
}

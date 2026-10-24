import type { IndexedPair } from "../../../../client";

/** A rung is `backend:model#effort`; the effort is optional (a native Claude rung has none). */
export function parseRung(rung: string): {
  backend: string;
  model: string;
  effort: string | null;
} {
  const colon = rung.indexOf(":");
  const hash = rung.lastIndexOf("#");
  const modelEnd = hash > colon ? hash : rung.length;
  return {
    backend: colon < 0 ? rung : rung.slice(0, colon),
    model: colon < 0 ? "" : rung.slice(colon + 1, modelEnd),
    effort: hash > colon ? rung.slice(hash + 1) : null,
  };
}

/** What the index knows of a pair, each part only when there is one. */
export function pairLine(p: IndexedPair): string {
  return [
    `benchmark ${p.intelligence.toFixed(1)}`,
    p.price ? `$${p.price.input}/$${p.price.output} per M` : null,
    p.speed === null ? null : `${Math.round(p.speed)} tok/s`,
    p.cost.tier === 0 ? "plan" : null,
  ]
    .filter((x) => x !== null)
    .join(" · ");
}

/** `rung` one place up or down, or the list as it is at an end. */
export function moveBy(list: string[], rung: string, delta: -1 | 1): string[] {
  const from = list.indexOf(rung);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const out = [...list];
  out.splice(from, 1);
  out.splice(to, 0, rung);
  return out;
}

/** The dragged rungs, in their current order, placed before or after `target`. */
export function dropAt(list: string[], dragged: Iterable<string>, target: string, position: "before" | "after") {
  const keys = new Set(dragged);
  const moving = list.filter((r) => keys.has(r));
  const rest = list.filter((r) => !moving.includes(r));
  const at = rest.indexOf(target) + (position === "after" ? 1 : 0);
  return at < 0 ? list : [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** Every rung any role is offered, once each. */
export const offeredRungs = (roles: { offered: IndexedPair[] }[]): string[] => [
  ...new Set(roles.flatMap((r) => r.offered.map((p) => p.rung))),
];

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"];

export { modelName } from "../../../../lib/model-name";

/** The efforts the index offers for the backend and model of `rung`, lowest first, its own effort included. */
export function effortsOf(rung: string, offered: { rung: string }[]): string[] {
  const { backend, model, effort } = parseRung(rung);
  const all = new Set<string>();
  for (const p of offered.map((x) => parseRung(x.rung)))
    if (p.backend === backend && p.model === model && p.effort !== null) all.add(p.effort);
  if (effort !== null) all.add(effort);
  const rank = (e: string) => (EFFORT_ORDER.includes(e) ? EFFORT_ORDER.indexOf(e) : EFFORT_ORDER.length);
  return [...all].sort((a, b) => rank(a) - rank(b));
}

/** `rung` with another effort. */
export const withEffort = (rung: string, effort: string): string => {
  const { backend, model } = parseRung(rung);
  return `${backend}:${model}#${effort}`;
};

/** The pairs split by backend, backends in the order they first appear. */
export function providerGroups(pairs: IndexedPair[]): { backend: string; pairs: IndexedPair[] }[] {
  const groups = new Map<string, IndexedPair[]>();
  for (const p of pairs) {
    const backend = parseRung(p.rung).backend;
    groups.set(backend, [...(groups.get(backend) ?? []), p]);
  }
  return [...groups].map(([backend, list]) => ({ backend, pairs: list }));
}

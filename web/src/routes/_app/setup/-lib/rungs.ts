import type { IndexedPair } from "../../../../client";

export const filterPairs = (offered: IndexedPair[], q: string): IndexedPair[] =>
  offered.filter((p) => p.rung.toLowerCase().includes(q.trim().toLowerCase()));

/** What the index knows of a pair, each part only when there is one. */
export function pairLine(p: IndexedPair): string {
  return [
    `intelligence ${p.intelligence.toFixed(1)}`,
    p.price ? `$${p.price.input}/$${p.price.output} per M` : null,
    p.speed === null ? null : `${Math.round(p.speed)} tok/s`,
    p.cost.tier === 0 ? "plan" : null,
  ]
    .filter((x) => x !== null)
    .join(" · ");
}

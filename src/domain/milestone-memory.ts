/**
 * Plan 35 D6: how many milestones of a base run may work side by side. A new one starts when none is working,
 * else when the memory the machine has free, less a reserve and less what the ramping milestones are still to take,
 * stays above a floor. The three megabyte numbers are the run profile's `limits.memory`.
 */
export const MEMORY_LIMITS = {
  reserveMb: 2048,
  perMilestoneMb: 3072,
  floorMb: 3072,
  /** a milestone counts at `perMilestoneMb` for this long after its tree is ready: its lanes have not reached their memory yet */
  rampMs: 300_000,
  recheckMs: 120_000,
} as const;

export type MemoryLimits = {
  reserveMb: number;
  perMilestoneMb: number;
  floorMb: number;
  rampMs: number;
  recheckMs: number;
};

/** The profile's own memory limits over the defaults. */
export function memoryLimitsOf(p: {
  limits?: { memory?: Partial<Pick<MemoryLimits, "reserveMb" | "perMilestoneMb" | "floorMb">> };
}): MemoryLimits {
  return { ...MEMORY_LIMITS, ...p.limits?.memory };
}

/** Milestones working (a tree, not landed, merged or parked) and those of them still ramping up. */
export function memoryLoad(
  ms: { tree: string | null; status: string; treeAt: string | null }[],
  nowMs: number,
  l: MemoryLimits = MEMORY_LIMITS,
): { working: number; ramping: number } {
  const working = ms.filter((m) => m.tree !== null && !["landed", "merged", "parked"].includes(m.status));
  return {
    working: working.length,
    ramping: working.filter((m) => m.treeAt !== null && Date.parse(m.treeAt) > nowMs - l.rampMs).length,
  };
}

/** The memory a deferral waits for: the reserve, what the ramping milestones will take, and the floor. */
export const neededMb = (ramping: number, l: MemoryLimits = MEMORY_LIMITS): number =>
  l.reserveMb + ramping * l.perMilestoneMb + l.floorMb;

/** Whether one more milestone may start: always when none is working, so a run always moves. */
export function mayStartMilestone(
  i: { availableMb: number; working: number; ramping: number },
  l: MemoryLimits = MEMORY_LIMITS,
): boolean {
  return i.working === 0 || i.availableMb - l.reserveMb - i.ramping * l.perMilestoneMb >= l.floorMb;
}

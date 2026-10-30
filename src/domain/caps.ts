/**
 * Spec D10's caps, pinned into `run.started` from the profile. Cost is the profile's `budget`, which admission
 * already refuses past; idle is plan 47's two-idle-turns rule.
 */
export interface Caps {
  /** the run's wall time in minutes, pauses excluded */
  wallMin: number;
  /** dispatches per ledger task */
  attempts: number;
}

/**
 * Plan 55, spec D5: where a base run's writers work. `writer`: each in its own worktree, merged into the run's branch;
 * `shared`: all on the run's one tree (stage 1), kept so stage 2 can be measured against it and reverted (O7).
 */
export const TREE_MODES = ["writer", "shared"] as const;
export type TreeMode = (typeof TREE_MODES)[number];

export const DEFAULT_CAPS: Caps = { wallMin: 720, attempts: 4 };
/** At this share of a cap the architect is woken once. */
export const CAP_WARN = 0.8;
/** Past the wall cap, tasks still running get this long before the run stops. */
export const CAP_GRACE_MS = 10 * 60_000;

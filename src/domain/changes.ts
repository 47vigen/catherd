import { overlaps } from "./lane.ts";

/**
 * `git status --porcelain=v1 -z` rows. A rename or copy (R/C in either column) carries its source path as
 * the next token; both paths are reported, so moving a file out of a path counts as a change to it.
 */
export function parsePorcelainZ(out: string): { xy: string; path: string }[] {
  const tokens = out.split("\0");
  const rows: { xy: string; path: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    rows.push({ xy, path: t.slice(3) });
    if (/[RC]/.test(xy)) {
      const source = tokens[++i];
      if (source) rows.push({ xy, path: source });
    }
  }
  return rows;
}

/** Repo-relative path → a fingerprint of its dirty state (status, size, mtime); clean paths are absent. */
export type Snapshot = Record<string, string>;

/**
 * The paths dirty after a run whose fingerprint differs from before it, so an edit to a file that was
 * already dirty counts. A path that became clean (committed or reverted meanwhile) does not.
 */
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return Object.keys(after)
    .filter((p) => before[p] !== after[p])
    .sort();
}

/**
 * Spec §4.4: `changedOwned` are the changes inside the lane's Owns; `violations` the ones outside it
 * that no overlapping dispatch owns either. `strict` is false for a laneless dispatch that may write
 * (it has no Owns to break), so it reports no violations.
 */
export function splitChanges(
  changed: string[],
  owns: string[],
  others: string[],
  strict: boolean,
): { changedOwned: string[]; violations: string[] } {
  const inside = (p: string, paths: string[]) => overlaps([p], paths).length > 0;
  return {
    changedOwned: changed.filter((p) => inside(p, owns)),
    violations: strict ? changed.filter((p) => !inside(p, owns) && !inside(p, others)) : [],
  };
}

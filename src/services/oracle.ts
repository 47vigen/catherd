import { type ArchState, type ArchTask, heldOracles } from "../domain/architect-state.ts";
import { git, type GitResult, snapshotTree } from "../infra/git.ts";
import { ledgerTasks } from "./ledger-store.ts";
import { replayRun } from "./run-events-store.ts";
import type { Run } from "./run-store.ts";
import { runTree } from "./tree-path.ts";

/** Plan 54: where a task's oracle diff is kept, in the run dir. */
export const oracleDiffFile = (taskId: string): string => `tasks/${taskId}/oracle.diff`;

/** The oracle paths of `ledgerTask`, or none. */
export const oracleOf = (run: Run, ledgerTask: string | null): string[] =>
  ledgerTask === null ? [] : (ledgerTasks(run).find((l) => l.id === ledgerTask)?.oracle ?? []);

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const why = (r: GitResult): string =>
  r.kind === "timed-out"
    ? "git timed out"
    : r.kind === "failed"
      ? `git exited ${r.exit ?? "without starting"}`
      : "";

/**
 * The tree a ledger task's held changes are judged against: the snapshot of its earliest task that is still held (or
 * `t` itself, when that is earlier), so a retry that restores a held edit is not held for undoing it.
 */
function baseOf(a: ArchState, t: ArchTask): ArchTask {
  return [t, ...heldOracles(a).filter((h) => h.ledgerTask === t.ledgerTask && h.snapshot !== null)].reduce(
    (first, x) => (x.delegatedSeq < first.delegatedSeq ? x : first),
  );
}

/**
 * Plan 54, spec D9: what a writer task changed in its ledger task's oracle, against the tree it was delegated on (or
 * an earlier still-held task's), with the diff's text for the caller to write. Null for any other task, an untouched
 * oracle or a missing tree. When git fails with a snapshot and a tree at hand the change is held anyway, on the
 * oracle's own pathspec, and the text says git could not diff. On the shared tree the diff holds every edit made while
 * the task worked, its own and any other's.
 */
export async function oracleChange(
  run: Run,
  taskId: string,
): Promise<{ paths: string[]; diff: string; text: string } | null> {
  const a = replayRun(run).arch;
  const t = a.tasks[taskId];
  if (!t?.snapshot || (t.role !== "worker" && t.role !== "writer")) return null;
  // R4: the set it was delegated against; an older event stream carries none, so the ledger's today
  const oracle = t.delegatedOracle ?? oracleOf(run, t.ledgerTask);
  if (oracle.length === 0) return null;
  let tree: string;
  try {
    tree = runTree(run);
  } catch {
    return null;
  }
  const held = (paths: string[], text: string) => ({ paths, diff: oracleDiffFile(taskId), text });
  const unable = (reason: string) => held(oracle, `git could not diff: ${reason}\n`);
  const base = baseOf(a, t).snapshot ?? t.snapshot;
  const after = await snapshotTree(tree);
  if (!after) return unable("it could not snapshot the tree");
  const names = await git(tree, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-only",
    base,
    after,
    "--",
    ...oracle,
  ]);
  if (names.kind !== "ok") return unable(why(names));
  const paths = lines(names.out);
  if (paths.length === 0) return null;
  const diff = await git(tree, ["diff", base, after, "--", ...paths]);
  if (diff.kind !== "ok") return held(paths, `git could not diff: ${why(diff)}\n`);
  return held(paths, diff.out || "git could not diff: it printed nothing\n");
}

/**
 * Plan 54, spec D9: each held oracle change the tree at HEAD still carries, as what land final needs. The held tasks of
 * a ledger task are judged together: HEAD matching the earliest one's snapshot on all their paths releases them all (a
 * restore, or a retry that undid the edit). A diff git cannot take (its snapshot is gone) still holds.
 */
export async function unreleasedOracles(tree: string, a: ArchState): Promise<string[]> {
  const groups = new Map<string | null, ArchTask[]>();
  for (const t of heldOracles(a)) groups.set(t.ledgerTask, [...(groups.get(t.ledgerTask) ?? []), t]);
  const out: string[] = [];
  for (const group of groups.values()) {
    const first = group.reduce((f, x) => (x.delegatedSeq < f.delegatedSeq ? x : f));
    const all = [...new Set(group.flatMap((t) => t.oracle?.paths ?? []))];
    const same =
      first.snapshot !== null &&
      (await git(tree, ["diff", "--quiet", first.snapshot, "HEAD", "--", ...all])).kind === "ok";
    if (!same)
      for (const t of group)
        out.push(
          `${t.taskId}'s change to ${(t.oracle?.paths ?? []).join(", ")}, the oracle of ${t.ledgerTask} (diff ${t.oracle?.diff}), accepted with oracle_accept or restored`,
        );
  }
  return out;
}

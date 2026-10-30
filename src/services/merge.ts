import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ArchMerge, type ArchTask, treeBusy } from "../domain/architect-state.ts";
import { runBranch } from "../domain/branch.ts";
import type { RunEventInput } from "../domain/run-events.ts";
import { git, gitRun } from "../infra/git.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { runArchitectCheck } from "./architect-check.ts";
import { oracleDiffFile, oracleOf } from "./oracle.ts";
import type { Deps } from "./ports.ts";
import { replayRun } from "./run-events-store.ts";
import type { Run } from "./run-store.ts";
import { runTree, taskBranch, taskTreeDir } from "./tree-path.ts";
import { removeTaskTree } from "./writer-tree.ts";

type MergeDone = Extract<RunEventInput, { type: "merge.done" }>;

/** What a merge that conflicted or went red sends back to the task's writer. */
export interface SendBack {
  cause: "conflict" | "red";
  text: string;
}

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const tail = (s: string): string => s.trim().slice(-600);

const out = async (dir: string, args: string[]): Promise<string | null> => {
  const r = await git(dir, args, 60_000);
  return r.kind === "ok" ? r.out : null;
};

/**
 * Plan 55, spec D5 and D9: merges a task's own tree into the run's branch, one merge at a time. catherd commits what
 * the tree holds, holds the merge when the writer changed its ledger task's oracle (until the architect accepts it),
 * merges the run's branch into the task's, runs the task's fast check there, then fast-forwards the run's branch and
 * removes the tree. A conflict or a red check leaves the run's branch as it was and is sent back to the writer.
 */
export async function runMerge(
  deps: Deps,
  run: Run,
  m: ArchMerge,
  checkMs: number,
): Promise<{ done: MergeDone; back: SendBack | null }> {
  const a = replayRun(run).arch;
  const t = a.tasks[m.taskId];
  const branch = runBranch(run.meta.title);
  const end = (
    outcome: MergeDone["outcome"],
    message: string,
    more: Partial<Pick<MergeDone, "sha" | "files" | "oracle">> = {},
    back: SendBack | null = null,
  ) => ({
    done: {
      type: "merge.done" as const,
      mergeId: m.mergeId,
      taskId: m.taskId,
      outcome,
      sha: null,
      files: [],
      message,
      ...more,
    },
    back,
  });
  if (!t?.tree) return end("refused", `${m.taskId} works on the run's tree: there is nothing to merge`);
  if (t.merged) return end("refused", `${m.taskId}'s tree is merged already`);
  if (treeBusy(a, t.tree))
    return end("refused", `a task still works in ${t.tree}'s tree: merge it when it ends`);
  const dir = taskTreeDir(run, t.tree);
  if (!existsSync(dir)) return end("refused", `${t.tree}'s tree is gone: ${dir}`);
  const integration = runTree(run);
  // the writer's work, committed: the merge, the check and the fast-forward all read commits
  const status = await out(dir, ["status", "--porcelain"]);
  if (status === null) return end("refused", `git cannot read ${dir}`);
  if (status.trim()) {
    await gitRun(dir, ["add", "-A"]);
    const c = await gitRun(dir, [
      "commit",
      "-q",
      "-m",
      `catherd: ${m.taskId}${t.ledgerTask ? ` (${t.ledgerTask})` : ""}`,
    ]);
    if (c.code !== 0) return end("refused", `git commit failed in ${dir}: ${tail(`${c.out}${c.err}`)}`);
  }
  const held = await heldOracle(run, a.tasks, t, dir, branch);
  if (held)
    return end(
      "held",
      `it changed ${held.paths.join(", ")}, the oracle of ledger ${t.ledgerTask} (diff ${held.diff}): accept it with oracle_accept and merge it again, or send the task back to restore it`,
      { files: held.paths, oracle: held },
    );
  const merged = await gitRun(dir, ["merge", "--no-edit", "-q", branch]);
  if (merged.code !== 0) {
    const files = lines((await out(dir, ["diff", "--name-only", "--diff-filter=U"])) ?? "");
    await gitRun(dir, ["merge", "--abort"]);
    const where = files.length ? files.join(", ") : tail(`${merged.out}${merged.err}`);
    return end(
      "conflict",
      `the run's branch conflicts with it in ${where}: catherd sends it back to its writer`,
      { files },
      {
        cause: "conflict",
        text: `Merging the run's branch \`${branch}\` into your tree conflicts in: ${where}. Run \`git merge ${branch}\` in your tree, resolve the conflicts, and leave the result uncommitted: catherd commits it and merges again when you end complete.`,
      },
    );
  }
  if (t.check) {
    const c = await runArchitectCheck(
      deps,
      run,
      {
        checkId: `${m.mergeId}-fast`,
        command: t.check,
        scope: "fast",
        base: false,
        fresh: false,
        state: "queued",
        ref: m.taskId,
      },
      { timeoutMs: checkMs },
    );
    // a failure the base has the same way is not this task's
    const inherited = c.failures.length > 0 && c.failures.every((f) => c.preExisting.includes(f));
    if (c.exit !== 0 && !inherited) {
      const failed = `\`${t.check}\` failed (exit ${c.exit ?? "timeout"}): ${c.failures.slice(0, 3).join("; ") || "no failing line read"}; log ${c.logPath}`;
      return end(
        "red",
        `its fast check in its tree, merged with the run's branch, ${failed}: catherd sends it back to its writer`,
        {},
        {
          cause: "red",
          text: `Your fast check ${failed.replace(`log ${c.logPath}`, `log ${join(run.dir, c.logPath)}`)}. It ran in your tree, merged with the run's branch \`${branch}\`. Fix it and end complete: catherd checks and merges again.`,
        },
      );
    }
  }
  const before = (await out(integration, ["rev-parse", "HEAD"]))?.trim() ?? "";
  const ff = await gitRun(integration, ["merge", "--ff-only", "-q", taskBranch(run, t.tree)]);
  if (ff.code !== 0)
    return end(
      "refused",
      `the run's tree did not fast-forward to ${m.taskId}'s work (${tail(`${ff.out}${ff.err}`)}): commit or drop your own edits there in the same files, then merge again`,
    );
  const sha = (await out(integration, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const files =
    sha && before ? lines((await out(integration, ["diff", "--name-only", before, sha])) ?? "") : [];
  await removeTaskTree(run, t.tree);
  return end(
    "merged",
    `${branch} is at ${sha?.slice(0, 12)}: ${files.length} file(s) from ${m.taskId}${files.length ? ` (${files.slice(0, 10).join(", ")}${files.length > 10 ? ", …" : ""})` : ""}`,
    { sha, files },
  );
}

/**
 * Spec D9 at the merge: the oracle paths the task's own commits changed since its tree left the run's branch, with
 * their diff written to the run dir; null when it left them alone or the architect accepted a change in this tree.
 */
async function heldOracle(
  run: Run,
  tasks: Record<string, ArchTask>,
  t: ArchTask,
  dir: string,
  branch: string,
): Promise<{ paths: string[]; diff: string } | null> {
  const oracle = t.delegatedOracle ?? oracleOf(run, t.ledgerTask);
  if (oracle.length === 0) return null;
  if (Object.values(tasks).some((x) => x.tree === t.tree && x.oracle?.accepted)) return null;
  const base = (await out(dir, ["merge-base", "HEAD", branch]))?.trim();
  // a tree git cannot compare is held on the oracle's own pathspec, as on the shared tree
  const names = base
    ? await out(dir, ["-c", "core.quotePath=false", "diff", "--name-only", base, "HEAD", "--", ...oracle])
    : null;
  const paths = names === null ? oracle : lines(names);
  if (paths.length === 0) return null;
  const diff = base ? await out(dir, ["diff", base, "HEAD", "--", ...paths]) : null;
  const file = oracleDiffFile(t.taskId);
  writeTextAtomic(join(run.dir, file), diff || "git could not diff\n");
  return { paths, diff: file };
}

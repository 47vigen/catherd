import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ArchMerge, type ArchTask, treeWorking } from "../domain/architect-state.ts";
import { runBranch } from "../domain/branch.ts";
import type { RunEventInput } from "../domain/run-events.ts";
import { errorMessage } from "../domain/errors.ts";
import type { Regen } from "../domain/profile.ts";
import { git, gitRun, snapshotTree } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { log } from "../infra/log.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { runArchitectCheck } from "./architect-check.ts";
import { checkEnvFor, runCheck } from "./check-command.ts";
import { runProfile } from "./run-pin.ts";
import { treeLimits } from "./run-tree.ts";
import { teamSend } from "./team.ts";
import { oracleDiffFile, oracleOf } from "./oracle.ts";
import type { Deps } from "./ports.ts";
import { replayRun, withEventsLock } from "./run-events-store.ts";
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

/** catherd's own commits and merges: its identity, no signing, and none of the repository's hooks (commitlint, lefthook). */
const own = [
  "-c",
  "user.name=catherd",
  "-c",
  "user.email=catherd@catherd.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

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
  const tree = t.tree;
  if (t.merged) return end("refused", `${m.taskId}'s tree is merged already`);
  if (treeWorking(a, t.tree))
    return end("refused", `a task still works in ${t.tree}'s tree: merge it when it ends`);
  const dir = taskTreeDir(run, t.tree);
  if (!existsSync(dir)) return end("refused", `${t.tree}'s tree is gone: ${dir}`);
  const integration = runTree(run);
  // the writer's work, committed: the merge, the check and the fast-forward all read commits
  const status = await out(dir, ["status", "--porcelain"]);
  if (status === null) return end("refused", `git cannot read ${dir}`);
  if (status.trim()) {
    const added = await gitRun(dir, ["add", "-A"]);
    if (added.code !== 0)
      return end("refused", `git add failed in ${dir}: ${tail(`${added.out}${added.err}`)}`);
    const c = await gitRun(dir, [
      ...own,
      "commit",
      "-q",
      "--no-verify",
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
  const regen = runProfile(deps, run).regen;
  const pre = (await out(dir, ["rev-parse", "HEAD"]))?.trim() ?? "";
  const merged = await gitRun(dir, [
    ...own,
    ...(regen ? regenConfig(run, regen.paths) : []),
    "merge",
    "--no-edit",
    "--no-verify",
    "-q",
    branch,
  ]);
  if (merged.code !== 0) {
    const files = lines((await out(dir, ["diff", "--name-only", "--diff-filter=U"])) ?? "");
    const aborted = await gitRun(dir, ["merge", "--abort"]);
    if (aborted.code !== 0)
      return end(
        "refused",
        `the run's branch conflicts with ${m.taskId} in ${files.join(", ") || "its tree"} and git could not abort the merge in ${dir} (${tail(`${aborted.out}${aborted.err}`)}): catherd keeps the tree; finish or abort that merge by hand`,
      );
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
  if (regen) {
    const failed = await regenerate(deps, run, dir, regen, pre, branch);
    if (failed)
      return end(
        "red",
        `${failed}: catherd sends it back to its writer`,
        {},
        {
          cause: "red",
          text: `After the run's branch \`${branch}\` merged into your tree, ${failed}. Fix it and end complete.`,
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
  // the last look and the move are one step under the events lock: a delegate appends under it too, so no task can
  // join the tree between the look and the removal
  return withEventsLock(run, async () => {
    const now = replayRun(run);
    const late = Object.values(now.arch.tasks).filter(
      (x) => x.tree === tree && x.delegatedSeq > m.seq && x.state !== "refused" && x.state !== "cancelled",
    );
    if (late.length)
      return end(
        "refused",
        `${late.map((x) => x.taskId).join(", ")} was delegated into ${tree}'s tree after this merge was asked for: catherd keeps the tree. Merge it again when that task ends`,
      );
    const before = (await out(integration, ["rev-parse", "HEAD"]))?.trim() ?? "";
    const ff = await gitRun(integration, [
      ...own,
      "merge",
      "--ff-only",
      "--no-verify",
      "-q",
      taskBranch(run, tree),
    ]);
    if (ff.code !== 0)
      return end(
        "refused",
        `the run's tree did not fast-forward to ${m.taskId}'s work (${tail(`${ff.out}${ff.err}`)}): commit or drop your own edits there in the same files, then merge again`,
      );
    const sha = (await out(integration, ["rev-parse", "HEAD"]))?.trim() ?? null;
    const files =
      sha && before ? lines((await out(integration, ["diff", "--name-only", before, sha])) ?? "") : [];
    await removeTaskTree(run, tree);
    return end(
      "merged",
      `${branch} is at ${sha?.slice(0, 12)}: ${files.length} file(s) from ${m.taskId}${files.length ? ` (${files.slice(0, 10).join(", ")}${files.length > 10 ? ", …" : ""})` : ""}`,
      { sha, files },
    );
  });
}

/**
 * Spec D5: a regenerable path never conflicts. Its `merge=regen` attribute's driver keeps the run's side (`cp %B %A`),
 * set for this one merge through `-c`, so neither the repository's config nor its attributes change.
 */
function regenConfig(run: Run, paths: string[]): string[] {
  const file = join(run.dir, "trees", "regen.attributes");
  writeTextAtomic(file, `${paths.map((p) => `${p} merge=regen`).join("\n")}\n`);
  return [
    "-c",
    `core.attributesFile=${file}`,
    "-c",
    "merge.regen.name=catherd: keep the run's side, then regenerate",
    "-c",
    "merge.regen.driver=cp %B %A",
  ];
}

/**
 * Spec D5: when both the task and the run's branch changed a regenerable path, the merge kept the run's side, so the
 * regenerate command rebuilds it in the task's tree and catherd commits the result. A failure's line, else null.
 */
async function regenerate(
  deps: Deps,
  run: Run,
  dir: string,
  regen: Regen,
  pre: string,
  branch: string,
): Promise<string | null> {
  const base = (await out(dir, ["merge-base", pre, branch]))?.trim();
  if (!base) return null;
  const changed = async (to: string) =>
    lines((await out(dir, ["diff", "--name-only", base, to, "--", ...regen.paths])) ?? "");
  const theirs = new Set(await changed(branch));
  const both = (await changed(pre)).filter((p) => theirs.has(p));
  if (both.length === 0) return null;
  const env = await checkEnvFor(run.meta.repo);
  const r = await withHeavySlot(heavySlots(runProfile(deps, run).heavy), (_slot, tmp) =>
    runCheck(dir, regen.command, treeLimits.setupMs, { ...env, TMPDIR: tmp, GOTMPDIR: tmp }),
  );
  if (r.timedOut || r.code !== 0)
    return `the regenerate command \`${regen.command}\` for ${both.join(", ")} ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${tail(r.tail.join("\n"))}`;
  if ((await out(dir, ["status", "--porcelain"]))?.trim()) {
    const added = await gitRun(dir, ["add", "-A"]);
    if (added.code !== 0)
      return `git add of the regenerated ${both.join(", ")} failed: ${tail(`${added.out}${added.err}`)}`;
    const c = await gitRun(dir, [
      ...own,
      "commit",
      "-q",
      "--no-verify",
      "-m",
      `catherd: regenerate ${both.join(", ")}`.slice(0, 100),
    ]);
    if (c.code !== 0)
      return `the commit of the regenerated ${both.join(", ")} failed: ${tail(`${c.out}${c.err}`)}`;
  }
  return null;
}

/**
 * Spec D5: after a merge, every running writer hears what landed (the completed-change notice), and a writer in its own
 * tree whose work would now conflict with the run's branch is told the paths at once (`git merge-tree` on a snapshot of
 * its tree; no tree is touched). A notice that cannot be sent is logged and never fails the merge.
 */
export async function noticeMerged(run: Run, done: MergeDone): Promise<void> {
  if (done.outcome !== "merged" || !done.sha) return;
  const branch = runBranch(run.meta.title);
  const files = done.files.length
    ? `${done.files.slice(0, 20).join(", ")}${done.files.length > 20 ? ", …" : ""}`
    : "no file changed";
  const head = `${done.taskId} merged into the run's branch \`${branch}\` at ${done.sha.slice(0, 12)}: ${files}.`;
  const writers = Object.values(replayRun(run).arch.tasks).filter(
    (t) => t.state === "working" && (t.role === "worker" || t.role === "writer" || t.role === "artist"),
  );
  for (const t of writers) {
    const conflicts = t.tree ? await predictedConflicts(taskTreeDir(run, t.tree), done.sha) : [];
    const text = !t.tree
      ? `${head} It is in the run's tree you work in.`
      : conflicts.length
        ? `${head} Your work would conflict with it in: ${conflicts.join(", ")}. Run \`git merge ${branch}\` in your tree now and resolve them.`
        : `${head} Run \`git merge ${branch}\` in your tree when you need that work.`;
    await teamSend({ run: run.id, from: "catherd", to: t.taskId, mode: "queue", text }).catch((e) =>
      log("warn", "daemon", { run: run.id, merge: done.mergeId, team: errorMessage(e) }),
    );
  }
}

/** The paths a writer's tree, as it is now, would conflict in with `sha`; none when it merges clean or git cannot say. */
async function predictedConflicts(dir: string, sha: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const snap = await snapshotTree(dir);
  if (!snap) return [];
  const r = await gitRun(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", sha, snap]);
  // exit 1 is a conflict: the tree's id, then one conflicted path a line
  return r.code === 1 ? [...new Set(lines(r.out).slice(1))] : [];
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

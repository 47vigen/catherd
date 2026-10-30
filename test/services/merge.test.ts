import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArchMerge } from "../../src/domain/architect-state.ts";
import { runBranch } from "../../src/domain/branch.ts";
import { db } from "../../src/infra/db.ts";
import { writeLedger } from "../../src/services/ledger-store.ts";
import { noticeMerged, runMerge } from "../../src/services/merge.ts";
import { teamMessages } from "../../src/services/team.ts";
import { realEffects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRunTree } from "../../src/services/run-tree.ts";
import { taskBranch, taskTreeDir } from "../../src/services/tree-path.ts";
import { claimTaskTree } from "../../src/services/writer-tree.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { commitInClone, snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

const RUNG = "codex:gpt-6-sol#high";
const CHECK_MS = 60_000;

const runBranchName = (run: Run): string => runBranch(run.meta.title);

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

const put = (dir: string, path: string, text: string): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

async function treesRun(seed?: { path: string; text: string }) {
  const { run, origin } = branchRun("wallet");
  if (seed) commitInClone(origin, "seed", seed);
  const deps = fakeDeps();
  const { tree } = await claimRunTree(deps, run);
  await appendEvent(run, { type: "run.started", ...startedFields, base: "main", trees: "writer" });
  return { run, deps, tree };
}

/** A worker task in its own tree that ended complete, its tree made. */
async function worked(
  run: Run,
  deps: ReturnType<typeof fakeDeps>,
  taskId: string,
  o: { check?: string; ledgerTask?: string; oracle?: string[]; end?: boolean } = {},
): Promise<string> {
  await appendEvent(run, {
    type: "task.delegated",
    taskId,
    role: "worker",
    rung: RUNG,
    thread: null,
    ledgerTask: o.ledgerTask ?? null,
    by: "architect-1",
    why: "w",
    tree: taskId,
    ...(o.check ? { check: o.check } : {}),
    ...(o.oracle ? { oracle: o.oracle } : {}),
  });
  const log = makeLog();
  const d = startDispatch(log, { name: taskId, unit: taskId });
  if (o.end !== false) endDispatch(log, d, { name: taskId, unit: taskId, thread: `th-${taskId}` });
  for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
  return claimTaskTree(deps, run, taskId);
}

// asked for after everything the tests delegated, unless a test gives the seq of a real `merge.requested`
const merge = (taskId: string, mergeId = "M1", seq = Number.MAX_SAFE_INTEGER): ArchMerge => ({
  mergeId,
  taskId,
  by: "catherd",
  state: "queued",
  seq,
});

/** Appends a worker task's delegation (and start) into `tree`, as a delegate that raced the merge would have. */
async function joined(run: Run, taskId: string, tree: string): Promise<void> {
  await appendEvent(run, {
    type: "task.delegated",
    taskId,
    role: "worker",
    rung: RUNG,
    thread: "th-T1",
    ledgerTask: null,
    by: "architect-1",
    why: "w",
    tree,
  });
}

describe("merging a writer's tree into the run's branch (plan 55, spec D5)", () => {
  it("commits the tree, checks it merged with the run's branch, fast-forwards the run's branch and removes the tree", async () => {
    const { run, deps, tree } = await treesRun();
    const dir = await worked(run, deps, "T1", { check: "test -f src/a.ts" });
    put(dir, "src/a.ts", "export const a = 1;\n");
    const before = git(tree, "rev-parse", "HEAD");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(back).toBeNull();
    expect(done).toMatchObject({ type: "merge.done", outcome: "merged", files: ["src/a.ts"] });
    expect(done.sha).toBe(git(tree, "rev-parse", "HEAD"));
    expect(done.sha).not.toBe(before);
    expect(readFileSync(join(tree, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(git(tree, "log", "-1", "--format=%s")).toBe("catherd: T1");
    expect(existsSync(taskTreeDir(run, "T1"))).toBe(false);
    expect(db().query("SELECT scope, exit, ref FROM checks WHERE check_id = 'M1-fast'").get()).toMatchObject({
      scope: "fast",
      exit: 0,
    });
  });

  it("sends a conflict back with its paths, and leaves the run's branch and the writer's tree as they were", async () => {
    const { run, deps, tree } = await treesRun({ path: "a.txt", text: "base\n" });
    const dir = await worked(run, deps, "T1");
    put(dir, "a.txt", "mine\n");
    put(tree, "a.txt", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    const head = git(tree, "rev-parse", "HEAD");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "conflict", files: ["a.txt"], sha: null });
    expect(back).toMatchObject({ cause: "conflict", text: expect.stringContaining("conflicts in: a.txt") });
    expect(git(tree, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(dir, ".git")) && git(dir, "status", "--porcelain")).toBe("");
  });

  it("sends a red fast check back with its failing lines, and leaves the run's branch as it was", async () => {
    const { run, deps, tree } = await treesRun();
    const dir = await worked(run, deps, "T1", { check: "echo '(fail) wallet balance'; exit 1" });
    put(dir, "b.txt", "x\n");
    const head = git(tree, "rev-parse", "HEAD");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "red", message: expect.stringContaining("(fail) wallet balance") });
    expect(back).toMatchObject({ cause: "red", text: expect.stringContaining("Your fast check") });
    expect(git(tree, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(dir)).toBe(true);
  });

  it("holds a merge whose writer changed its oracle, and merges it once the architect accepts (spec D9)", async () => {
    const { run, deps, tree } = await treesRun({ path: "test/pay.test.ts", text: 'it("pays", () => {});\n' });
    writeLedger(
      run,
      { tasks: { add: [{ id: "L1", goal: "pay", oracle: ["test/pay.test.ts"] }] } },
      new Date(),
    );
    const dir = await worked(run, deps, "T1", { ledgerTask: "L1", oracle: ["test/pay.test.ts"] });
    put(dir, "test/pay.test.ts", 'it.skip("pays", () => {});\n');
    const head = git(tree, "rev-parse", "HEAD");
    const held = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(held.done).toMatchObject({
      outcome: "held",
      oracle: { paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff" },
    });
    expect(readFileSync(join(run.dir, "tasks/T1/oracle.diff"), "utf8")).toContain('+it.skip("pays"');
    expect(git(tree, "rev-parse", "HEAD")).toBe(head);
    await appendEvent(run, held.done);
    await appendEvent(run, {
      type: "oracle.accepted",
      taskId: "T1",
      by: "architect-1",
      why: "it pays later",
    });
    expect((await runMerge(deps, run, merge("T1", "M2"), CHECK_MS)).done).toMatchObject({
      outcome: "merged",
    });
  });

  it("refuses a task on the run's tree, and a tree a task still works in", async () => {
    const { run, deps } = await treesRun();
    await worked(run, deps, "T1", { end: false });
    expect((await runMerge(deps, run, merge("T1"), CHECK_MS)).done).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("still works"),
    });
    expect((await runMerge(deps, run, merge("T9"), CHECK_MS)).done.outcome).toBe("refused");
  });

  it("sends a conflicted task back to its writer as a new task in the same tree (the effect)", async () => {
    const { run, deps, tree } = await treesRun({ path: "a.txt", text: "base\n" });
    const dir = await worked(run, deps, "T1");
    put(dir, "a.txt", "mine\n");
    put(tree, "a.txt", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    await appendEvent(run, { type: "merge.requested", mergeId: "M1", taskId: "T1", by: "catherd", why: "w" });
    await realEffects(deps, run).run({ type: "merge", mergeId: "M1" }, replayRun(run));
    const events = readEvents(run);
    expect(events.find((e) => e.type === "task.delegated" && e.taskId === "T2")).toMatchObject({
      by: "catherd",
      cause: "conflict",
      tree: "T1",
      thread: "th-T1",
      rung: RUNG,
    });
    expect(events.at(-1)).toMatchObject({
      type: "merge.done",
      outcome: "conflict",
      message: expect.stringMatching(/: catherd sent it back as T2$/),
    });
    expect(readFileSync(join(run.dir, "tasks/T2/brief.md"), "utf8")).toContain("conflicts in: a.txt");
  });
});

describe("a merge never takes a tree a later task joined (plan 55 review C1)", () => {
  it("refuses at the fast-forward, and keeps the tree with the late task's work, when a task was delegated into it during the check", async () => {
    const { run, deps, tree } = await treesRun();
    const dir = await worked(run, deps, "T1", {
      check: "touch ../started; until [ -f ../go ]; do sleep 0.02; done",
    });
    put(dir, "one.txt", "one\n");
    const requested = await appendEvent(run, {
      type: "merge.requested",
      mergeId: "M1",
      taskId: "T1",
      by: "catherd",
      why: "w",
    });
    const head = git(tree, "rev-parse", "HEAD");
    const running = runMerge(deps, run, merge("T1", "M1", requested.seq), CHECK_MS);
    while (!existsSync(join(run.dir, "trees", "started"))) await Bun.sleep(5);
    await joined(run, "T2", "T1");
    put(dir, "late.txt", "T2's work\n");
    writeFileSync(join(run.dir, "trees", "go"), "");
    const { done } = await running;
    expect(done).toMatchObject({ outcome: "refused", message: expect.stringContaining("T2") });
    expect(git(tree, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(dir, "late.txt"))).toBe(true);
    expect(git(run.meta.repo, "branch", "--list", taskBranch(run, "T1"))).not.toBe("");
  });
});

describe("catherd's own commits and merges ignore the repository's hooks (plan 55 review I1)", () => {
  it("commits, merges the run's branch in and commits the regenerated lockfile past hooks that reject everything", async () => {
    const { run, deps, tree } = await treesRun({ path: "bun.lock", text: "v1\n" });
    deps.view.regen = { paths: ["bun.lock"], command: "printf 'regenerated\\n' > bun.lock" };
    const dir = await worked(run, deps, "T1");
    put(dir, "bun.lock", "mine\n");
    put(tree, "bun.lock", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    const hooks = join(run.meta.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "commit-msg", "pre-merge-commit", "post-merge", "post-commit"]) {
      writeFileSync(join(hooks, name), "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n", { mode: 0o755 });
    }
    const { done } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "merged", files: ["bun.lock"] });
    expect(readFileSync(join(tree, "bun.lock"), "utf8")).toBe("regenerated\n");
    expect(git(tree, "log", "-1", "--format=%s")).toBe("catherd: regenerate bun.lock");
  });

  it("sends the task back as red when the regenerated lockfile cannot be committed, never dropping it silently", async () => {
    const { run, deps, tree } = await treesRun({ path: "bun.lock", text: "v1\n" });
    // the command leaves a lock file behind that makes the commit fail
    deps.view.regen = {
      paths: ["bun.lock"],
      command: "printf 'regenerated\\n' > bun.lock; touch \"$(git rev-parse --git-path index.lock)\"",
    };
    const dir = await worked(run, deps, "T1");
    put(dir, "bun.lock", "mine\n");
    put(tree, "bun.lock", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "red", message: expect.stringContaining("regenerat") });
    expect(back?.cause).toBe("red");
  });
});

describe("conflict markers are never committed (plan 55 review I2)", () => {
  it("sends back a tree that ends complete with markers in it, and commits nothing", async () => {
    const { run, deps, tree } = await treesRun({ path: "a.txt", text: "base\n" });
    const dir = await worked(run, deps, "T1");
    put(dir, "a.txt", "<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> wallet\n");
    put(dir, "new.txt", "fine\n");
    const head = git(tree, "rev-parse", "HEAD");
    const own = git(dir, "rev-parse", "HEAD");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "conflict", files: ["a.txt"] });
    expect(back).toMatchObject({ cause: "conflict", text: expect.stringContaining("a.txt:1") });
    expect(git(dir, "rev-parse", "HEAD")).toBe(own);
    expect(git(tree, "rev-parse", "HEAD")).toBe(head);
    // the writer's files, markers and all, and its index are as they were
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toContain("<<<<<<<");
    expect(git(dir, "status", "--porcelain")).toBe("M a.txt\n?? new.txt");
  });

  it("sends back a tree a crash left in the middle of catherd's own merge, instead of concluding it", async () => {
    const { run, deps, tree } = await treesRun({ path: "a.txt", text: "base\n" });
    const dir = await worked(run, deps, "T1");
    put(dir, "a.txt", "mine\n");
    git(dir, "commit", "-q", "-am", "mine");
    put(tree, "a.txt", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    expect(() => git(dir, "merge", "--no-edit", runBranchName(run))).toThrow();
    expect(existsSync(git(dir, "rev-parse", "--absolute-git-dir") + "/MERGE_HEAD")).toBe(true);
    const own = git(dir, "rev-parse", "HEAD");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "conflict", files: ["a.txt"] });
    expect(back?.cause).toBe("conflict");
    expect(git(dir, "rev-parse", "HEAD")).toBe(own);
    expect(existsSync(git(dir, "rev-parse", "--absolute-git-dir") + "/MERGE_HEAD")).toBe(true);
    expect(git(tree, "log", "-1", "--format=%s")).toBe("theirs");
  });

  it("concludes a merge the writer resolved, as the sent-back text tells it to", async () => {
    const { run, deps, tree } = await treesRun({ path: "a.txt", text: "base\n" });
    const dir = await worked(run, deps, "T1");
    put(dir, "a.txt", "mine\n");
    git(dir, "commit", "-q", "-am", "mine");
    put(tree, "a.txt", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    expect(() => git(dir, "merge", "--no-edit", runBranchName(run))).toThrow();
    put(dir, "a.txt", "both\n");
    const { done } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "merged" });
    expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("both\n");
  });
});

describe("after a merge (plan 55, spec D5)", () => {
  it("keeps the run's side of a regenerable path both sides changed, then regenerates it in the task's tree", async () => {
    const { run, deps, tree } = await treesRun({ path: "bun.lock", text: "v1\n" });
    deps.view.regen = { paths: ["bun.lock"], command: "printf 'regenerated\\n' > bun.lock" };
    const dir = await worked(run, deps, "T1");
    put(dir, "bun.lock", "mine\n");
    put(tree, "bun.lock", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    const { done } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "merged", files: ["bun.lock"] });
    expect(readFileSync(join(tree, "bun.lock"), "utf8")).toBe("regenerated\n");
    expect(git(tree, "log", "-1", "--format=%s")).toBe("catherd: regenerate bun.lock");
  });

  it("sends the task back when the regenerate command fails", async () => {
    const { run, deps, tree } = await treesRun({ path: "bun.lock", text: "v1\n" });
    deps.view.regen = { paths: ["bun.lock"], command: "echo 'registry down'; exit 7" };
    const dir = await worked(run, deps, "T1");
    put(dir, "bun.lock", "mine\n");
    put(tree, "bun.lock", "theirs\n");
    git(tree, "commit", "-q", "-am", "theirs");
    const { done, back } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    expect(done).toMatchObject({ outcome: "red", message: expect.stringContaining("exited 7") });
    expect(back?.cause).toBe("red");
  });

  it("tells every running writer what merged, and a writer in its own tree the paths it would now conflict in", async () => {
    const { run, deps } = await treesRun({ path: "a.txt", text: "base\n" });
    const one = await worked(run, deps, "T1");
    put(one, "a.txt", "one\n");
    const two = await worked(run, deps, "T2", { end: false });
    put(two, "a.txt", "two\n");
    await appendEvent(run, {
      type: "task.delegated",
      taskId: "T3",
      role: "writer",
      rung: RUNG,
      thread: null,
      ledgerTask: null,
      by: "architect-1",
      why: "w",
    });
    const log = makeLog();
    startDispatch(log, { name: "T3", unit: "T3" });
    for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    const { done } = await runMerge(deps, run, merge("T1"), CHECK_MS);
    await noticeMerged(run, done);
    const sent = teamMessages(run);
    expect(sent.find((m) => m.to === "T2")?.text).toContain("Your work would conflict with it in: a.txt");
    expect(sent.find((m) => m.to === "T3")?.text).toContain("It is in the run's tree you work in");
    expect(
      sent.every((m) => m.from === "catherd" && m.text.startsWith("T1 merged into the run's branch")),
    ).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArchMerge } from "../../src/domain/architect-state.ts";
import { db } from "../../src/infra/db.ts";
import { writeLedger } from "../../src/services/ledger-store.ts";
import { runMerge } from "../../src/services/merge.ts";
import { realEffects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRunTree } from "../../src/services/run-tree.ts";
import { taskTreeDir } from "../../src/services/tree-path.ts";
import { claimTaskTree } from "../../src/services/writer-tree.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { commitInClone, snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

const RUNG = "codex:gpt-6-sol#high";
const CHECK_MS = 60_000;

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

const merge = (taskId: string, mergeId = "M1"): ArchMerge => ({
  mergeId,
  taskId,
  by: "catherd",
  state: "queued",
});

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

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchLand } from "../../src/domain/architect-state.ts";
import { runArchitectCheck } from "../../src/services/architect-check.ts";
import { forge, runLand } from "../../src/services/land.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRunTree } from "../../src/services/run-tree.ts";
import { snapshotTree } from "../../src/infra/git.ts";
import { commitInClone, snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());
const realForge = forge.open;
afterEach(() => {
  forge.open = realForge;
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** `runLand`, then the `land.done` the land effect appends, so a later land of the run sees it. */
async function landed(run: Run, l: ArchLand): ReturnType<typeof runLand> {
  const r = await runLand(run, l);
  await appendEvent(run, r.done);
  return r;
}

const noCachedHead = (run: Run) => sh(run.meta.repo, "remote", "set-head", "origin", "-d");

const land = (final: boolean, n = 1): ArchLand => ({
  landId: `L${n}`,
  final,
  why: "w",
  state: "queued",
});
const deps = fakeDeps();

async function tree(
  title = "t",
  ...seeds: { path: string; text: string }[]
): Promise<{ run: Run; tree: string; origin: string; bodies: string[] }> {
  const { run, origin } = branchRun(title);
  for (const seed of seeds) commitInClone(origin, "seed", seed);
  const bodies: string[] = [];
  forge.open = async (o) => {
    bodies.push(o.body);
    return "https://git.example.com/o/r/-/merge_requests/7";
  };
  const t = await claimRunTree(deps, run);
  return { run, tree: t.tree, origin, bodies };
}

async function fullCheck(run: Run, checkId = "C1"): Promise<void> {
  const done = await runArchitectCheck(
    deps,
    run,
    {
      checkId,
      command: "true",
      scope: "full",
      base: false,
      fresh: true,
      state: "queued",
    },
    { timeoutMs: 10_000 },
  );
  expect(done.exit).toBe(0);
}

async function verifierPass(run: Run, head: string): Promise<void> {
  await appendEvent(run, {
    type: "dispatch.ended",
    dispatchId: "d-v",
    name: "T9",
    unit: "T9",
    status: "ok",
    replyStatus: "complete",
    reason: null,
    why: "ok",
    thread: null,
    head,
    environment: null,
    verdict: "pass",
    findings: [],
    replyPath: "roles/T9/d-v/reply.md",
  });
}

describe("land (plan 50, spec D11)", () => {
  it("leaves the checks catherd asked for out of the MR audit, and keeps the architect's (plan 53)", async () => {
    const { run, tree: t, bodies } = await tree();
    writeFileSync(join(t, "a.ts"), "export const a = 1;\n");
    const ask = (checkId: string, by: string, why: string, task?: string) =>
      appendEvent(run, {
        type: "check.requested",
        checkId,
        command: "true",
        scope: task ? "fast" : "full",
        base: false,
        fresh: false,
        by,
        why,
        ...(task ? { task } : {}),
      });
    await ask("C1", "catherd", "T1 ended complete: its fast check", "T1");
    await ask("C2", "architect-1", "the integrated product");
    await runLand(run, land(false));
    expect(bodies[0]).toContain("the integrated product");
    expect(bodies[0]).not.toContain("its fast check");
  });

  it("commits the tree, pushes the run's branch and opens its MR, problem first", async () => {
    const { run, tree: t, origin, bodies } = await tree();
    writeFileSync(join(t, "a.ts"), "export const a = 1;\n");
    const r = await runLand(run, land(false));
    const head = sh(t, "rev-parse", "HEAD");
    expect(r.done).toMatchObject({
      outcome: "pushed",
      branch: "t",
      sha: head,
      mr: expect.stringContaining("/7"),
    });
    expect(r.question).toBeNull();
    expect(sh(origin, "rev-parse", "t")).toBe(head);
    expect(sh(t, "log", "-1", "--format=%s")).toBe("chore: t");
    expect(bodies[0]?.startsWith("## Problem\n\nt\n\n- A1 it works")).toBe(true);
    expect(readFileSync(join(run.dir, "land", "mr.md"), "utf8")).toBe(bodies[0] as string);
  });

  it("refuses final without a green full check and a verifier PASS on the pushed commit, then asks the owner", async () => {
    const { run, tree: t } = await tree();
    writeFileSync(join(t, "a.ts"), "export const a = 1;\n");
    const first = await landed(run, land(true));
    const head = sh(t, "rev-parse", "HEAD");
    expect(first.done.outcome).toBe("refused");
    expect(first.done.message).toContain(`a green full check on ${head.slice(0, 12)}`);
    expect(first.done.message).toContain(`a verifier PASS whose HEAD line names ${head.slice(0, 12)}`);
    await fullCheck(run);
    await verifierPass(run, head.slice(0, 10));
    const second = await runLand(run, land(true, 2));
    expect(second.done).toMatchObject({ outcome: "pushed", sha: head });
    expect(second.question).toStartWith("Merge https://git.example.com/o/r/-/merge_requests/7 into main?");
  });

  it("lands final on a full check whose every failure the base has too, and lists them under Known issues (plan 52)", async () => {
    const { run, tree: t, bodies } = await tree();
    writeFileSync(join(t, "a.ts"), "export const a = 1;\n");
    await landed(run, land(false));
    const head = sh(t, "rev-parse", "HEAD");
    const done = await runArchitectCheck(
      deps,
      run,
      {
        checkId: "C1",
        command: "echo '(fail) old flake'; exit 1",
        scope: "full",
        base: false,
        fresh: true,
        state: "queued",
      },
      { timeoutMs: 10_000 },
    );
    expect(done.verdict).toBe("inherited");
    await verifierPass(run, head);
    const r = await runLand(run, land(true, 2));
    expect(r.done).toMatchObject({ outcome: "pushed", sha: head });
    expect(bodies.at(-1)).toContain(
      "- inherited from the base (`echo '(fail) old flake'; exit 1`): (fail) old flake",
    );
    expect(bodies.at(-1)).toContain("passed but for 1 failure the base has too");
  });

  it("lists an inherited failure once when the architect logged it as a known issue too (plan 52)", async () => {
    const { run, tree: t, bodies } = await tree();
    writeFileSync(join(t, "a.ts"), "export const a = 1;\n");
    await landed(run, land(false));
    const head = sh(t, "rev-parse", "HEAD");
    const cmd = "echo '(fail) old flake'; exit 1";
    await runArchitectCheck(
      deps,
      run,
      {
        checkId: "C1",
        command: cmd,
        scope: "full",
        base: false,
        fresh: true,
        state: "queued",
      },
      { timeoutMs: 10_000 },
    );
    await appendEvent(run, {
      type: "task.delegated",
      taskId: "T1",
      role: "reviewer",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      ledgerTask: null,
      by: "architect-1",
      why: "review",
    });
    await appendEvent(run, {
      type: "dispatch.started",
      dispatchId: "d-r",
      name: "T1",
      role: "reviewer",
      unit: "T1",
      lane: null,
      rung: "codex:gpt-6-sol#high",
      thread: null,
    });
    await appendEvent(run, {
      type: "dispatch.ended",
      dispatchId: "d-r",
      name: "T1",
      unit: "T1",
      status: "ok",
      replyStatus: "complete",
      reason: null,
      why: "ok",
      thread: null,
      head: null,
      environment: null,
      verdict: null,
      findings: [
        {
          label: "PRE-EXISTING",
          text: "(fail) old flake fails on the base",
          file: null,
        },
      ],
      replyPath: "roles/T1/d-r/reply.md",
    });
    await verifierPass(run, head);
    await runLand(run, land(true, 2));
    const body = bodies.at(-1) ?? "";
    expect(body).toContain("(fail) old flake fails on the base");
    expect(body).not.toContain("inherited from the base (");
  });

  it("lists the test cases the run removed and the existing test files it rewrote (plan 54, spec D9)", async () => {
    const {
      run,
      tree: t,
      bodies,
    } = await tree(
      "t",
      {
        path: "test/pay.test.ts",
        text: 'it("keeps the currency", () => {\n  expect(1).toBe(1);\n});\nit("rounds", () => {});\n',
      },
      {
        path: "test/fee.test.ts",
        text: 'it("fee", () => {\n  expect(fee(1)).toBe(2);\n});\n',
      },
    );
    writeFileSync(join(t, "test", "pay.test.ts"), 'it("rounds", () => {});\n');
    writeFileSync(join(t, "test", "fee.test.ts"), 'it("fee", () => {\n  expect(fee(1)).toBe(3);\n});\n');
    writeFileSync(join(t, "test", "new.test.ts"), 'it("new", () => {});\n');
    await runLand(run, land(false));
    const body = bodies.at(-1) ?? "";
    expect(body).toContain("- removed or renamed test/pay.test.ts: keeps the currency");
    expect(body).toContain("- rewritten test/fee.test.ts (-1 line)");
    expect(body).not.toContain("rewritten test/pay.test.ts");
    expect(body).not.toContain("new.test.ts");
  });

  it("reports a removed test under a non-ASCII path, nothing of a deleted file's cases, and no snapshot as rewritten (plan 54)", async () => {
    const {
      run,
      tree: t,
      bodies,
    } = await tree(
      "t",
      {
        path: "test/é.test.ts",
        text: 'it("keeps é", () => {});\nit("stays", () => {});\n',
      },
      {
        path: "test/gone.test.ts",
        text: 'it("lost with its file", () => {});\n',
      },
      { path: "test/__snapshots__/x.snap", text: "a\nb\n" },
      { path: "src/z.ts", text: "export const z = 1;\n" },
    );
    writeFileSync(join(t, "test", "é.test.ts"), 'it("stays", () => {});\n');
    rmSync(join(t, "test", "gone.test.ts"));
    writeFileSync(join(t, "test", "__snapshots__", "x.snap"), "a\n");
    await runLand(run, land(false));
    const body = bodies.at(-1) ?? "";
    expect(body).toContain("- removed or renamed test/é.test.ts: keeps é");
    expect(body).toContain("- deleted test/gone.test.ts");
    expect(body).not.toContain("lost with its file");
    expect(body).not.toContain("x.snap");
  });

  it("holds land final on an oracle change until it is restored or accepted, and lists the override (plan 54, spec D9)", async () => {
    const pay = 'it("keeps the currency", () => {});\n';
    const { run, tree: t, bodies } = await tree("t", { path: "test/pay.test.ts", text: pay });
    const snapshot = (await snapshotTree(t)) as string;
    await appendEvent(run, {
      type: "task.delegated",
      taskId: "T1",
      role: "worker",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      ledgerTask: "L1",
      by: "architect-1",
      why: "pay",
      snapshot,
    });
    await appendEvent(run, {
      type: "dispatch.started",
      dispatchId: "d-w",
      name: "T1",
      role: "worker",
      unit: "T1",
      lane: null,
      rung: "codex:gpt-6-sol#high",
      thread: null,
    });
    await appendEvent(run, {
      type: "dispatch.ended",
      dispatchId: "d-w",
      name: "T1",
      unit: "T1",
      status: "ok",
      replyStatus: "complete",
      reason: null,
      why: "ok",
      thread: null,
      head: null,
      environment: null,
      verdict: null,
      findings: [],
      replyPath: "roles/T1/d-w/reply.md",
      oracle: { paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff" },
    });
    const HELD =
      "T1's change to test/pay.test.ts, the oracle of L1 (diff tasks/T1/oracle.diff), accepted with oracle_accept or restored";
    writeFileSync(
      join(t, "test", "pay.test.ts"),
      'it("keeps the currency", () => { expect(1).toBe(2); });\n',
    );
    await landed(run, land(false));
    let head = sh(t, "rev-parse", "HEAD");
    await fullCheck(run);
    await verifierPass(run, head);
    expect((await landed(run, land(true, 2))).done.message).toContain(`land final needs ${HELD}`);
    writeFileSync(join(t, "test", "pay.test.ts"), pay);
    expect((await landed(run, land(true, 3))).done.message).not.toContain("oracle");
    writeFileSync(
      join(t, "test", "pay.test.ts"),
      'it("keeps the currency", () => { expect(1).toBe(3); });\n',
    );
    await appendEvent(run, {
      type: "oracle.accepted",
      taskId: "T1",
      by: "architect-2",
      why: "the old fee",
    });
    await landed(run, land(false, 4));
    head = sh(t, "rev-parse", "HEAD");
    await fullCheck(run, "C2");
    await verifierPass(run, head);
    const r = await landed(run, land(true, 5));
    expect(r.done.outcome).toBe("pushed");
    expect(bodies.at(-1)).toContain(
      "### Oracle overrides\n\n- T1 (L1) changed test/pay.test.ts: the old fee",
    );
    expect(bodies.at(-1)).toContain("architect-2 accepted T1's oracle change: the old fee");
  });

  it("releases every held task of a ledger task when HEAD matches the earliest snapshot on their paths (plan 54)", async () => {
    const pay = 'it("keeps the currency", () => {});\n';
    const { run, tree: t } = await tree("t", { path: "test/pay.test.ts", text: pay });
    const snap1 = (await snapshotTree(t)) as string;
    // T1 changed the oracle; its retry T2 was delegated on that edit, restored the file and was held too
    writeFileSync(join(t, "test", "pay.test.ts"), 'it("keeps the currency", () => { weak(); });\n');
    const snap2 = (await snapshotTree(t)) as string;
    for (const [taskId, snapshot] of [
      ["T1", snap1],
      ["T2", snap2],
    ] as const) {
      await appendEvent(run, {
        type: "task.delegated",
        taskId,
        role: "worker",
        rung: "codex:gpt-6-sol#high",
        thread: null,
        ledgerTask: "L1",
        by: "architect-1",
        why: "pay",
        snapshot,
      });
      await appendEvent(run, {
        type: "dispatch.started",
        dispatchId: `d-${taskId}`,
        name: taskId,
        role: "worker",
        unit: taskId,
        lane: null,
        rung: "codex:gpt-6-sol#high",
        thread: null,
      });
      await appendEvent(run, {
        type: "dispatch.ended",
        dispatchId: `d-${taskId}`,
        name: taskId,
        unit: taskId,
        status: "ok",
        replyStatus: "complete",
        reason: null,
        why: "ok",
        thread: null,
        head: null,
        environment: null,
        verdict: null,
        findings: [],
        replyPath: `roles/${taskId}/reply.md`,
        oracle: { paths: ["test/pay.test.ts"], diff: `tasks/${taskId}/oracle.diff` },
      });
    }
    await landed(run, land(false));
    let head = sh(t, "rev-parse", "HEAD");
    await fullCheck(run);
    await verifierPass(run, head);
    const refused = (await landed(run, land(true, 2))).done.message;
    expect(refused).toContain("T1's change to test/pay.test.ts");
    expect(refused).toContain("T2's change to test/pay.test.ts");
    writeFileSync(join(t, "test", "pay.test.ts"), pay);
    await landed(run, land(false, 3));
    head = sh(t, "rev-parse", "HEAD");
    await fullCheck(run, "C2");
    await verifierPass(run, head);
    expect((await landed(run, land(true, 4))).done.message).not.toContain("oracle");
  });

  it("merges a base that moved under the run's files and asks for the check again", async () => {
    const { run, tree: t, origin } = await tree("t", { path: "shared.txt", text: "top\n\n\n\nbottom\n" });
    writeFileSync(join(t, "shared.txt"), "TOP\n\n\n\nbottom\n");
    await landed(run, land(false));
    commitInClone(origin, "base side", { path: "other.txt", text: "x\n" });
    await fullCheck(run);
    await verifierPass(run, sh(t, "rev-parse", "HEAD"));
    // a base commit on a file the run never touched is not a move
    expect((await landed(run, land(true, 2))).done.outcome).toBe("pushed");
    const clone = commitInClone(origin, "base edits shared", {
      path: "shared.txt",
      text: "top\n\n\n\nbottom!\n",
    });
    const moved = await runLand(run, land(true, 3));
    expect(moved.done.outcome).toBe("refused");
    expect(moved.done.message).toContain("the base moved under shared.txt: merged origin/main");
    expect(sh(t, "merge-base", "--is-ancestor", clone, "HEAD")).toBe("");
  });

  it("never pushes a protected branch, and says how to open the MR when the forge CLI fails", async () => {
    const { run } = await tree("master");
    expect((await runLand(run, land(false))).done).toMatchObject({
      outcome: "refused",
      message: "master is a protected branch: catherd never pushes it",
    });
    const other = await tree();
    forge.open = async () => {
      throw new Error("glab: not logged in");
    };
    const r = await runLand(other.run, land(false));
    expect(r.done.outcome).toBe("pushed");
    expect(r.done.message).toContain(
      "the MR was not opened (glab: not logged in): open it with glab mr create",
    );
  });

  it("refuses a tree that is not on the run's branch, and keeps a push config from retargeting the push", async () => {
    const { run, tree: t, origin } = await tree();
    sh(run.meta.repo, "config", "remote.origin.push", "+refs/heads/*:refs/heads/other/*");
    writeFileSync(join(t, "a.ts"), "export const a = 1;\n");
    const pushed = await runLand(run, land(false));
    expect(pushed.done.outcome).toBe("pushed");
    expect(sh(origin, "rev-parse", "t")).toBe(sh(t, "rev-parse", "HEAD"));
    expect(sh(origin, "for-each-ref", "refs/heads/other")).toBe("");
    sh(t, "checkout", "-q", "--detach");
    writeFileSync(join(t, "b.ts"), "export const b = 1;\n");
    const r = await runLand(run, land(false, 2));
    expect(r.done).toMatchObject({ outcome: "refused", sha: null });
    expect(r.done.message).toContain("no branch checked out, not t");
    expect(sh(t, "status", "--porcelain")).toContain("b.ts"); // nothing was committed
  });

  it("resolves origin's default branch from the remote when origin/HEAD is not cached", async () => {
    const { run, origin } = await tree("develop");
    sh(origin, "branch", "develop", "main");
    sh(origin, "symbolic-ref", "HEAD", "refs/heads/develop");
    noCachedHead(run);
    const r = await runLand(run, land(false));
    expect(r.done).toMatchObject({
      outcome: "refused",
      message: "develop is a protected branch: catherd never pushes it",
    });
    expect(sh(origin, "rev-parse", "develop")).toBe(sh(origin, "rev-parse", "main"));
  });

  it("refuses when origin's default branch cannot be resolved", async () => {
    const { run, origin } = await tree();
    sh(origin, "symbolic-ref", "HEAD", "refs/heads/nowhere");
    noCachedHead(run);
    const r = await runLand(run, land(false));
    expect(r.done.outcome).toBe("refused");
    expect(r.done.message).toContain("origin's default branch");
    expect(() => sh(origin, "rev-parse", "--verify", "t")).toThrow();
  });

  it("refuses the first push of a branch that exists on origin and is not from this run", async () => {
    const { run, tree: t, origin } = await tree();
    sh(origin, "branch", "t", "main");
    const r = await runLand(run, land(false));
    expect(r.done.outcome).toBe("refused");
    expect(r.done.message).toContain("branch t already exists on origin");
    expect(sh(origin, "rev-parse", "t")).toBe(sh(origin, "rev-parse", "main"));
    expect(sh(t, "rev-parse", "HEAD")).toBe(sh(origin, "rev-parse", "main"));
  });

  it("lands again after a daemon died between the first push and its land.done", async () => {
    const { run, tree: t, origin } = await tree();
    // the first land pushed and recorded its intent, but its land.done was never appended
    const first = await runLand(run, land(false));
    expect(first.done.outcome).toBe("pushed");
    writeFileSync(join(t, "more.txt"), "more\n");
    const again = await runLand(run, land(false, 2));
    expect(again.done.outcome).toBe("pushed");
    expect(sh(origin, "rev-parse", "t")).toBe(sh(t, "rev-parse", "HEAD"));
  });

  it("still refuses an unrelated branch of the run's name, also when an intent was recorded", async () => {
    const { run, tree: t, origin } = await tree();
    await appendEvent(run, {
      type: "land.started",
      landId: "L0",
      branch: "t",
      sha: "0".repeat(40),
    });
    sh(origin, "branch", "t", "main");
    const r = await runLand(run, land(false));
    expect(r.done.outcome).toBe("refused");
    expect(r.done.message).toContain("branch t already exists on origin");
    expect(sh(t, "rev-parse", "HEAD")).toBe(sh(origin, "rev-parse", "main"));
  });
});

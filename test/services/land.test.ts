import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchLand } from "../../src/domain/architect-state.ts";
import { runArchitectCheck } from "../../src/services/architect-check.ts";
import { forge, runLand } from "../../src/services/land.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRunTree } from "../../src/services/run-tree.ts";
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

const land = (final: boolean, n = 1): ArchLand => ({ landId: `L${n}`, final, why: "w", state: "queued" });
const deps = fakeDeps();

async function tree(
  title = "t",
  seed?: { path: string; text: string },
): Promise<{ run: Run; tree: string; origin: string; bodies: string[] }> {
  const { run, origin } = branchRun(title);
  if (seed) commitInClone(origin, "seed", seed);
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
    { checkId, command: "true", scope: "full", base: false, fresh: true, state: "queued" },
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
    await appendEvent(run, { type: "land.started", landId: "L0", branch: "t", sha: "0".repeat(40) });
    sh(origin, "branch", "t", "main");
    const r = await runLand(run, land(false));
    expect(r.done.outcome).toBe("refused");
    expect(r.done.message).toContain("branch t already exists on origin");
    expect(sh(t, "rev-parse", "HEAD")).toBe(sh(origin, "rev-parse", "main"));
  });
});

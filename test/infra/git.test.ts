import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths } from "../../src/domain/changes.ts";
import { commitExists, git, gitHead, gitToplevel, statusSnapshot } from "../../src/infra/git.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";

afterEach(snapshotEnv());

/** Puts a fake `git` running `body` first on PATH. */
function fakeGit(body: string): void {
  const bin = mkdtempSync(join(tmpdir(), "catherd-fakegit-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

describe("git", () => {
  it("finds the toplevel from a subdirectory, and null outside a repo", async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(await gitToplevel(join(repo, "src", "deep"))).toBe(repo);
    expect(await gitToplevel(mkdtempSync(join(tmpdir(), "catherd-nogit-")))).toBeNull();
  });

  it("reads HEAD and checks that a commit exists", async () => {
    const repo = tempRepo();
    const head = sh(repo, "rev-parse", "--short", "HEAD");
    expect(await gitHead(repo)).toBe(head);
    expect(await commitExists(repo, head)).toBe(true);
    expect(await commitExists(repo, "0123456789abcdef")).toBe(false);
    expect(await gitHead(mkdtempSync(join(tmpdir(), "catherd-nogit-")))).toBeNull();
  });

  it("snapshots untracked files inside new folders and modified tracked ones", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.ts"), "1");
    sh(repo, "add", "a.ts");
    sh(repo, "commit", "-qm", "a");
    writeFileSync(join(repo, "a.ts"), "2");
    mkdirSync(join(repo, "src", "new"), { recursive: true });
    writeFileSync(join(repo, "src", "new", "b.ts"), "b");
    const snap = await statusSnapshot(repo);
    expect(Object.keys(snap).sort()).toEqual(["a.ts", "src/new/b.ts"]);
    expect(snap["a.ts"]?.startsWith(" M ")).toBe(true);
  });

  it("sees an edit to a file that was already dirty before", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.ts"), "draft");
    const before = await statusSnapshot(repo);
    writeFileSync(join(repo, "a.ts"), "draft, then the worker's edit");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(repo, "a.ts"), later, later);
    expect(changedPaths(before, await statusSnapshot(repo))).toEqual(["a.ts"]);
  });

  it("throws outside a repository rather than look clean", async () => {
    const p = statusSnapshot(mkdtempSync(join(tmpdir(), "catherd-nogit-")));
    await expect(p).rejects.toMatchObject({ code: "E_IO_UNEXPECTED" });
  });
});

describe("git failures", () => {
  it("tells ok, a failed exit and a timeout apart", async () => {
    const repo = tempRepo();
    expect(await git(repo, ["rev-parse", "HEAD"])).toMatchObject({ kind: "ok" });
    fakeGit("exit 128");
    expect(await git(repo, ["status"])).toEqual({ kind: "failed", exit: 128 });
    fakeGit("sleep 5");
    const t0 = Date.now();
    expect(await git(repo, ["status"], 200)).toEqual({ kind: "timed-out" });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("on a failed git: no HEAD, no commit, and a snapshot that throws", async () => {
    const repo = tempRepo();
    fakeGit("exit 128");
    expect(await gitHead(repo)).toBeNull();
    expect(await commitExists(repo, "0123456789abcdef")).toBe(false);
    const snap = statusSnapshot(repo);
    await expect(snap).rejects.toMatchObject({
      code: "E_IO_UNEXPECTED",
      fix: `check that git works in ${repo}`,
    });
  });

  it("on a git that times out: no HEAD, and commitExists and the snapshot throw", async () => {
    const repo = tempRepo();
    fakeGit("sleep 5");
    expect(await gitHead(repo, 200)).toBeNull();
    await expect(commitExists(repo, "0123456789abcdef", 200)).rejects.toMatchObject({
      code: "E_IO_UNEXPECTED",
    });
    await expect(statusSnapshot(repo, 200)).rejects.toMatchObject({ code: "E_IO_UNEXPECTED" });
  });
});

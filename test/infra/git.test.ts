import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths } from "../../src/domain/changes.ts";
import {
  commitExists,
  currentBranch,
  fetchBase,
  git,
  gitHead,
  gitRun,
  gitToplevel,
  isAncestor,
  statusSnapshot,
  updateSubmodules,
  worktreeIdentity,
} from "../../src/infra/git.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { commitInClone, repoWithOrigin, snapshotEnv, tempRepo } from "../helpers.ts";

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

  it("worktreeIdentity changes with every uncommitted change and holds otherwise", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "tracked.txt"), "original");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "tracked file");
    const clean = await worktreeIdentity(repo);
    expect(clean).toMatch(/^[a-f0-9]{64}$/);
    expect(await worktreeIdentity(repo)).toBe(clean);

    writeFileSync(join(repo, "tracked.txt"), "unstaged edit");
    const edited = await worktreeIdentity(repo);
    expect(edited).not.toBeNull();
    expect(edited).not.toBe(clean);
    sh(repo, "add", "tracked.txt");
    expect(await worktreeIdentity(repo)).toBe(edited);

    writeFileSync(join(repo, "tracked.txt"), "edit after staging");
    const editedAgain = await worktreeIdentity(repo);
    expect(editedAgain).not.toBeNull();
    expect(editedAgain).not.toBe(edited);

    mkdirSync(join(repo, "new", "folder"), { recursive: true });
    const untracked = join(repo, "new", "folder", "untracked.txt");
    writeFileSync(untracked, "first");
    const added = await worktreeIdentity(repo);
    expect(added).not.toBeNull();
    expect(added).not.toBe(editedAgain);
    writeFileSync(untracked, "other");
    const changed = await worktreeIdentity(repo);
    expect(changed).not.toBeNull();
    expect(changed).not.toBe(added);

    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "worker changes");
    const committed = await worktreeIdentity(repo);
    expect(committed).not.toBeNull();
    expect(committed).not.toBe(changed);
    writeFileSync(join(repo, "tracked.txt"), "temporary edit");
    expect(await worktreeIdentity(repo)).not.toBe(committed);
    writeFileSync(join(repo, "tracked.txt"), "edit after staging");
    expect(await worktreeIdentity(repo)).toBe(committed);
    writeFileSync(join(repo, "ignored.txt"), "ignored content");
    expect(await worktreeIdentity(repo)).toBe(committed);
  });

  it("worktreeIdentity gives an unchanged tracked deletion a stable identity", async () => {
    const repo = tempRepo();
    const file = join(repo, "tracked.txt");
    writeFileSync(file, "original");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "tracked file");
    const clean = await worktreeIdentity(repo);
    expect(clean).not.toBeNull();
    unlinkSync(file);
    const deleted = await worktreeIdentity(repo);
    expect(deleted).toMatch(/^[a-f0-9]{64}$/);
    expect(deleted).not.toBe(clean);
    expect(await worktreeIdentity(repo)).toBe(deleted);
    writeFileSync(file, "original");
    expect(await worktreeIdentity(repo)).toBe(clean);
  });

  it("worktreeIdentity includes untracked symlink targets and file types", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a"), "same");
    writeFileSync(join(repo, "b"), "same");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "targets");
    const link = join(repo, "link");
    symlinkSync("a", link);
    const first = await worktreeIdentity(repo);
    expect(first).not.toBeNull();
    unlinkSync(link);
    symlinkSync("b", link);
    const second = await worktreeIdentity(repo);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    unlinkSync(link);
    writeFileSync(link, "same");
    expect(await worktreeIdentity(repo)).not.toBe(second);
  });

  it("worktreeIdentity includes executable modes even when Git ignores file modes", async () => {
    const repo = tempRepo();
    sh(repo, "config", "core.filemode", "false");
    const file = join(repo, "script");
    writeFileSync(file, "echo test");
    chmodSync(file, 0o644);
    const untracked = await worktreeIdentity(repo);
    expect(untracked).not.toBeNull();
    chmodSync(file, 0o755);
    expect(await worktreeIdentity(repo)).not.toBe(untracked);
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "script");
    const tracked = await worktreeIdentity(repo);
    expect(tracked).not.toBeNull();
    chmodSync(file, 0o644);
    expect(await worktreeIdentity(repo)).not.toBe(tracked);
  });

  it("worktreeIdentity includes tracked bytes hidden by Git normalization", async () => {
    const repo = tempRepo();
    sh(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, ".gitattributes"), "*.txt text\n");
    writeFileSync(join(repo, "normalized.txt"), "line\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "normalized text");
    const clean = await worktreeIdentity(repo);
    expect(clean).not.toBeNull();
    writeFileSync(join(repo, "normalized.txt"), "line\r\n");
    expect(sh(repo, "diff", "HEAD")).toBe("");
    const changed = await worktreeIdentity(repo);
    expect(changed).not.toBeNull();
    expect(changed).not.toBe(clean);
  });

  it("worktreeIdentity is unknown for successive edits in an already dirty submodule", async () => {
    const source = tempRepo();
    writeFileSync(join(source, "tracked"), "initial");
    sh(source, "add", ".");
    sh(source, "commit", "-qm", "submodule content");
    const repo = tempRepo();
    sh(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
    sh(repo, "commit", "-qm", "submodule");
    writeFileSync(join(repo, "sub", "tracked"), "first edit");
    const firstDiff = sh(repo, "diff", "HEAD");
    expect(await worktreeIdentity(repo)).toBeNull();
    writeFileSync(join(repo, "sub", "tracked"), "second edit");
    expect(sh(repo, "diff", "HEAD")).toBe(firstDiff);
    expect(await worktreeIdentity(repo)).toBeNull();
  });

  it("worktreeIdentity is null when git cannot say", async () => {
    const outside = mkdtempSync(join(tmpdir(), "catherd-nogit-"));
    expect(await worktreeIdentity(outside)).toBeNull();
    sh(outside, "init", "-q");
    expect(await worktreeIdentity(outside)).toBeNull();
    const repo = tempRepo();
    fakeGit("exit 128");
    expect(await worktreeIdentity(repo)).toBeNull();
  });

  it("worktreeIdentity returns null on a later git failure or timeout", async () => {
    const repo = tempRepo();
    for (const command of ["diff", "ls-files"]) {
      fakeGit(`if [ "$3" = "${command}" ]; then exit 128; fi\nprintf 'head'`);
      expect(await worktreeIdentity(repo)).toBeNull();
    }
    fakeGit("while :; do :; done");
    expect(await worktreeIdentity(repo, 50)).toBeNull();
  });

  it("worktreeIdentity returns null when an untracked file disappears before reading", async () => {
    const repo = tempRepo();
    fakeGit('if [ "$3" = "ls-files" ]; then printf "missing.txt\\0"; else printf "head"; fi');
    expect(await worktreeIdentity(repo)).toBeNull();
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

describe("the base branch", () => {
  it("fetches origin's base and tells whether a commit is behind it", async () => {
    const { repo, origin } = repoWithOrigin();
    const mine = sh(repo, "rev-parse", "HEAD");
    const moved = commitInClone(origin, "moved");
    expect(await isAncestor(repo, moved, "origin/main")).toBeNull(); // not fetched yet: git does not know the commit
    expect(await fetchBase(repo, "main")).toBe(true);
    expect(await isAncestor(repo, moved, "origin/main")).toBe(true);
    expect(await isAncestor(repo, mine, "origin/main")).toBe(true);
    expect(await isAncestor(repo, "origin/main", mine)).toBe(false);
    expect(await currentBranch(repo)).toBe("main");
  });

  it("says nothing sure when git cannot tell, and fetches nothing from a repo without origin", async () => {
    const repo = tempRepo();
    expect(await fetchBase(repo, "main")).toBe(false);
    expect(await isAncestor(repo, "HEAD", "origin/nope")).toBeNull();
    sh(repo, "checkout", "-q", "--detach");
    expect(await currentBranch(repo)).toBeNull();
  });
});

describe("git environment", () => {
  it("keeps catherd's own secret out of git's environment, and the rest in", async () => {
    const repo = tempRepo();
    process.env.TYPESAFE_API_KEY = "tsk_FAKEKEY_DO_NOT_USE_1234567890";
    process.env.CATHERD_TEST_KEEP = "kept";
    fakeGit("env");
    const r = await git(repo, ["status"]);
    expect(r.kind).toBe("ok");
    const out = r.kind === "ok" ? r.out : "";
    expect(out).not.toContain("TYPESAFE_API_KEY");
    expect(out).not.toContain("FAKEKEY");
    expect(out).toContain("CATHERD_TEST_KEEP=kept");
    expect(out).toContain("GIT_OPTIONAL_LOCKS=0");
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

  it("gitRun on a timeout kills what git started too, such as a commit hook", async () => {
    const repo = tempRepo();
    const pidFile = join(mkdtempSync(join(tmpdir(), "catherd-hook-")), "pid");
    fakeGit(`sleep 300 &\necho $! > ${pidFile}\nwait`);
    const r = await gitRun(repo, ["commit"], 1500);
    expect(r.timedOut).toBe(true);
    const hook = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 500 && isAlive(hook, null); i++) await Bun.sleep(10);
    expect(isAlive(hook, null)).toBe(false);
  });
});

describe("updateSubmodules", () => {
  it("checks a worktree's submodule out from the main checkout's copy, without alternates", async () => {
    const { repo: sub, origin: subOrigin } = repoWithOrigin();
    const pinned = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sub, encoding: "utf8" }).trim();
    const superRepo = tempRepo();
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
    const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    run(superRepo, "submodule", "add", "-q", subOrigin, "lib");
    run(superRepo, "commit", "-q", "-m", "add lib");
    const tree = join(mkdtempSync(join(tmpdir(), "catherd-subtree-")), "t");
    run(superRepo, "worktree", "add", "-q", tree);
    const r = await updateSubmodules(tree, 30_000);
    expect(r.code).toBe(0);
    const lib = join(tree, "lib");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: lib, encoding: "utf8" }).trim()).toBe(pinned);
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: lib,
      encoding: "utf8",
    }).trim();
    expect(existsSync(join(gitDir, "objects/info/alternates"))).toBe(false);
  });
});

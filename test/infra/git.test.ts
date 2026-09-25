import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths } from "../../src/domain/changes.ts";
import { commitExists, gitHead, gitToplevel, statusSnapshot } from "../../src/infra/git.ts";
import { tempRepo } from "../helpers.ts";

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
    expect(await gitHead(mkdtempSync(join(tmpdir(), "catherd-nogit-")))).toBe("none");
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

  it("is empty outside a repository", async () => {
    expect(await statusSnapshot(mkdtempSync(join(tmpdir(), "catherd-nogit-")))).toEqual({});
  });
});

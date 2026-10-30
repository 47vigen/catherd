import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parsePorcelainZ, type Snapshot } from "../domain/changes.ts";
import { CatherdError } from "../domain/errors.ts";
import { scrubSecrets } from "./env.ts";
import { killGroup } from "./proc.ts";

/** How one git command ended: its stdout, a failure (exit null when git could not start), or a timeout. */
export type GitResult =
  | { kind: "ok"; out: string }
  | { kind: "failed"; exit: number | null }
  | { kind: "timed-out" };

/** How long one git command may run by default; finalize's claim window counts it (tests shorten it). */
export const gitLimits = { timeoutMs: 15_000 };

/**
 * `git -C repo <args>` with a timeout. GIT_OPTIONAL_LOCKS=0 keeps `status` from taking index.lock,
 * which would fail a worker's own git command running at the same moment. On a timeout git is killed
 * and its stdout is not awaited, since a grandchild may still hold the pipe open.
 */
export async function git(
  repo: string,
  args: string[],
  timeoutMs = gitLimits.timeoutMs,
  env: Record<string, string> = {},
): Promise<GitResult> {
  let p: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    p = Bun.spawn(["git", "-C", repo, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...scrubSecrets(process.env), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env },
    });
  } catch {
    return { kind: "failed", exit: null };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, timeoutMs);
  const out = new Response(p.stdout).text().catch(() => "");
  const code = await p.exited;
  clearTimeout(timer);
  if (timedOut) return { kind: "timed-out" };
  return code === 0 ? { kind: "ok", out: await out } : { kind: "failed", exit: code };
}

const gitBroken = (repo: string, args: string[], r: GitResult) =>
  new CatherdError(
    "E_IO_UNEXPECTED",
    `git ${args[0]} ${r.kind === "timed-out" ? "timed out" : "failed"} in ${repo}`,
    { fix: `check that git works in ${repo}` },
  );

export async function gitToplevel(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.kind === "ok" ? r.out.trim() || null : null;
}

/** The repo's `origin` remote URL, or null when it has none (or git cannot say). */
export async function gitOrigin(repo: string): Promise<string | null> {
  const r = await git(repo, ["config", "--get", "remote.origin.url"]);
  return (r.kind === "ok" && r.out.trim()) || null;
}

/** The short HEAD, or null when git cannot say (no commit, not a repo, failure, timeout). */
export async function gitHead(repo: string, timeoutMs?: number): Promise<string | null> {
  const r = await git(repo, ["rev-parse", "--short", "HEAD"], timeoutMs);
  return (r.kind === "ok" && r.out.trim()) || null;
}

/** A clean submodule's HEAD, "empty" for one not initialized, null for a dirty one or when git cannot say. */
async function submoduleIdentity(dir: string, timeoutMs?: number): Promise<string | null> {
  if (readdirSync(dir).length === 0) return "empty";
  const status = await git(dir, ["status", "--porcelain", "--untracked-files=all"], timeoutMs);
  if (status.kind !== "ok" || status.out.trim() !== "") return null;
  const head = await git(dir, ["rev-parse", "HEAD"], timeoutMs);
  return head.kind === "ok" ? head.out.trim() : null;
}

/**
 * A content identity of HEAD, tracked changes and non-ignored untracked files, staged or not.
 * Null when git cannot say, a listed file cannot be read, or a submodule is dirty.
 */
export async function worktreeIdentity(repo: string, timeoutMs?: number): Promise<string | null> {
  const head = await git(repo, ["rev-parse", "HEAD"], timeoutMs);
  if (head.kind !== "ok") return null;
  const diff = await git(
    repo,
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"],
    timeoutMs,
  );
  if (diff.kind !== "ok") return null;
  const untracked = await git(repo, ["ls-files", "-z", "--others", "--exclude-standard"], timeoutMs);
  if (untracked.kind !== "ok") return null;
  const tracked = await git(repo, ["ls-files", "-z", "--cached"], timeoutMs);
  if (tracked.kind !== "ok") return null;
  const hash = createHash("sha256").update(head.out).update("\0").update(diff.out).update("\0");
  try {
    const trackedPaths = new Set(tracked.out.split("\0").filter(Boolean));
    const untrackedPaths = new Set(untracked.out.split("\0").filter(Boolean));
    const paths = new Set([...trackedPaths, ...untrackedPaths]);
    for (const path of [...paths].sort()) {
      const fullPath = join(repo, path);
      const stat = lstatSync(fullPath, { throwIfNoEntry: false });
      if (!stat) {
        if (untrackedPaths.has(path)) return null;
        hash.update(path).update("\0deleted\0");
        continue;
      }
      // a submodule (a tracked directory) is its recorded commit, and only while its own tree is clean
      if (stat.isDirectory() && trackedPaths.has(path)) {
        const sub = await submoduleIdentity(fullPath, timeoutMs);
        if (sub === null) return null;
        hash.update(path).update("\0submodule\0").update(sub).update("\0");
        continue;
      }
      // Direct bytes catch normalization and mode changes Git's diff can hide.
      if (!stat.isFile() && !stat.isSymbolicLink()) return null;
      const type = stat.isSymbolicLink() ? "link" : "file";
      const content = stat.isSymbolicLink()
        ? readlinkSync(fullPath, { encoding: "buffer" })
        : readFileSync(fullPath);
      // Length framing prevents file contents from being mistaken for another path or file.
      hash
        .update(path)
        .update("\0")
        .update(`${type}\0${stat.mode & 0o111}\0${content.length}\0`)
        .update(content);
    }
  } catch {
    return null;
  }
  return hash.digest("hex");
}

/** False for a missing commit; throws E_IO_UNEXPECTED when git times out, since that proves nothing. */
export async function commitExists(repo: string, commit: string, timeoutMs?: number): Promise<boolean> {
  const args = ["cat-file", "-e", `${commit}^{commit}`];
  const r = await git(repo, args, timeoutMs);
  if (r.kind === "timed-out") throw gitBroken(repo, args, r);
  return r.kind === "ok";
}

function fingerprint(repo: string, xy: string, path: string): string {
  try {
    const s = statSync(join(repo, path));
    return `${xy} ${s.size} ${s.mtimeMs}`;
  } catch {
    return `${xy} gone`;
  }
}

/**
 * The repo's dirty files, each with a fingerprint. Throws E_IO_UNEXPECTED when git fails or times out
 * (including outside a repository), so a broken git never reads as a clean tree.
 */
export async function statusSnapshot(repo: string, timeoutMs?: number): Promise<Snapshot> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  const r = await git(repo, args, timeoutMs);
  if (r.kind !== "ok") throw gitBroken(repo, args, r);
  const snap: Snapshot = {};
  for (const { xy, path } of parsePorcelainZ(r.out)) snap[path] = fingerprint(repo, xy, path);
  return snap;
}

/** What a git command printed and how it ended, for the callers that show a failure (a commit hook's output). */
export interface GitOutput {
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
}

/**
 * `git -C repo <args>` with both streams, for a command that may run hooks (a commit): a long timeout, and no
 * optional lock avoidance, since this one writes the index. It leads its own process group, so a timeout kills the
 * hooks it started too: one left running would go on changing the index while the caller retries.
 */
export async function gitRun(
  repo: string,
  args: string[],
  timeoutMs = 300_000,
  env: Record<string, string> = {},
): Promise<GitOutput> {
  let p: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    p = Bun.spawn(["git", "-C", repo, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...scrubSecrets(process.env), LC_ALL: "C", ...env },
      detached: true,
    });
  } catch (e) {
    return { code: null, out: "", err: (e as Error).message, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p.pid, "SIGKILL");
  }, timeoutMs);
  const out = new Response(p.stdout).text().catch(() => "");
  const err = new Response(p.stderr).text().catch(() => "");
  const code = await p.exited;
  clearTimeout(timer);
  return {
    code: timedOut ? null : code,
    out: timedOut ? "" : await out,
    err: timedOut ? "" : await err,
    timedOut,
  };
}

/**
 * `git submodule update --init --recursive`, borrowing each submodule's objects from the main checkout's copy at
 * `<common-dir>/modules/<name>` when it has one; `--dissociate` keeps the tree from depending on it afterwards.
 * Returns the first failing step, else the last one.
 */
export async function updateSubmodules(repo: string, timeoutMs?: number): Promise<GitOutput> {
  const init = await gitRun(repo, ["submodule", "init"], timeoutMs);
  if (init.code !== 0) return init;
  const common = await gitRun(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], timeoutMs);
  if (common.code !== 0) return common;
  const paths = await gitRun(repo, [
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  let last = init;
  for (const line of paths.out.split("\n").filter(Boolean)) {
    const m = /^submodule\.(.+)\.path (.+)$/.exec(line);
    if (!m) continue;
    const local = join(common.out.trim(), "modules", m[1] as string);
    const borrow = existsSync(local) ? ["--reference", local, "--dissociate"] : [];
    last = await gitRun(
      repo,
      ["submodule", "update", "--init", "--recursive", ...borrow, "--", m[2] as string],
      timeoutMs,
    );
    if (last.code !== 0) return last;
  }
  return last;
}

/**
 * `git fetch -q origin <base>` with a cap: catherd's one network git call (spec 2.0 decision 21). True when it
 * exits 0; a failure never throws, the caller works from the last fetch and says so.
 */
export async function fetchBase(repo: string, base: string, timeoutMs = 60_000): Promise<boolean> {
  const r = await gitRun(repo, ["fetch", "-q", "origin", base], timeoutMs);
  return r.code === 0;
}

/** Whether `commit` is an ancestor of `ref`: true on exit 0, false on 1, null when git cannot tell. */
export async function isAncestor(repo: string, commit: string, ref: string): Promise<boolean | null> {
  const r = await git(repo, ["merge-base", "--is-ancestor", commit, ref]);
  if (r.kind === "ok") return true;
  return r.kind === "failed" && r.exit === 1 ? false : null;
}

/** The checked-out branch, or null when HEAD is detached (or git cannot say). */
export async function currentBranch(repo: string): Promise<string | null> {
  const r = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = r.kind === "ok" ? r.out.trim() : "";
  return name && name !== "HEAD" ? name : null;
}

/**
 * Runs `fn` against a throwaway copy of the tree's index with every file added (untracked ones in), so the real index
 * and files stay untouched. A copy of the real index keeps git's stat cache, so only changed files are hashed again.
 * Null when the copy or the add fails.
 */
async function inScratchIndex<T>(
  dir: string,
  fn: (env: Record<string, string>) => Promise<T | null>,
): Promise<T | null> {
  const index = join(
    tmpdir(),
    `catherd-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = { GIT_INDEX_FILE: index };
  try {
    // without GIT_INDEX_FILE, which --git-path would echo back
    const r = await git(dir, ["rev-parse", "--git-path", "index"]);
    const real = r.kind === "ok" ? r.out.trim() : null;
    try {
      if (!real) throw new Error("no index");
      copyFileSync(isAbsolute(real) ? real : join(dir, real), index);
    } catch {
      if ((await git(dir, ["read-tree", "HEAD"], 60_000, env)).kind !== "ok") return null;
    }
    if ((await git(dir, ["add", "-A"], 60_000, env)).kind !== "ok") return null;
    return await fn(env);
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Spec D5's checkpoint recipe, used by plan 51's reviews: the tree as it is, committed or not, untracked files in, as a
 * commit on HEAD that no ref holds. A throwaway index keeps the owner's index and files untouched. Null on a failure.
 */
export function snapshotTree(dir: string): Promise<string | null> {
  return inScratchIndex(dir, async (env) => {
    const step = async (args: string[]) => {
      const r = await git(dir, args, 60_000, env);
      return r.kind === "ok" ? r.out.trim() : null;
    };
    const tree = await step(["write-tree"]);
    if (!tree) return null;
    const id = ["-c", "user.name=catherd", "-c", "user.email=catherd@catherd.invalid"];
    return (await step([...id, "commit-tree", tree, "-p", "HEAD", "-m", "catherd: review snapshot"])) || null;
  });
}

/**
 * The `path:line` of every leftover conflict marker the tree would commit if everything were added (an unmerged path
 * included), read on a throwaway index against `base` (HEAD by default; a writer's tree passes where it left the run's
 * branch, so its own commits are read too); whitespace complaints of `diff --check` are not markers. Null when git
 * cannot say.
 */
export function conflictMarkers(dir: string, base = "HEAD"): Promise<string[] | null> {
  return inScratchIndex(dir, async (env) => {
    const r = await gitRun(
      dir,
      ["-c", "core.quotePath=false", "diff", "--cached", "--check", base],
      60_000,
      env,
    );
    // exit 2 is "problems found"; anything else non-zero is git failing
    if (r.code !== 0 && r.code !== 2) return null;
    return r.out
      .split("\n")
      .filter((l) => l.includes(": leftover conflict marker"))
      .map((l) => l.slice(0, l.indexOf(": leftover conflict marker")));
  });
}

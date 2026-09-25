import { statSync } from "node:fs";
import { join } from "node:path";
import { parsePorcelainZ, type Snapshot } from "../domain/changes.ts";
import { CatherdError } from "../domain/errors.ts";

/** How one git command ended: its stdout, a failure (exit null when git could not start), or a timeout. */
export type GitResult =
  | { kind: "ok"; out: string }
  | { kind: "failed"; exit: number | null }
  | { kind: "timed-out" };

/**
 * `git -C repo <args>` with a timeout. GIT_OPTIONAL_LOCKS=0 keeps `status` from taking index.lock,
 * which would fail a worker's own git command running at the same moment. On a timeout git is killed
 * and its stdout is not awaited, since a grandchild may still hold the pipe open.
 */
export async function git(repo: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
  let p: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    p = Bun.spawn(["git", "-C", repo, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
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

/** The short HEAD, or null when git cannot say (no commit, not a repo, failure, timeout). */
export async function gitHead(repo: string, timeoutMs?: number): Promise<string | null> {
  const r = await git(repo, ["rev-parse", "--short", "HEAD"], timeoutMs);
  return (r.kind === "ok" && r.out.trim()) || null;
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

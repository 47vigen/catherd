import { statSync } from "node:fs";
import { join } from "node:path";
import { parsePorcelainZ, type Snapshot } from "../domain/changes.ts";

/**
 * `git -C repo <args>` with a timeout. GIT_OPTIONAL_LOCKS=0 keeps `status` from taking index.lock,
 * which would fail a worker's own git command running at the same moment.
 */
export async function git(
  repo: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["git", "-C", repo, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { ok: code === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

export async function gitToplevel(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out.trim() || null : null;
}

export async function gitHead(repo: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--short", "HEAD"]);
  return (r.ok && r.out.trim()) || "none";
}

export async function commitExists(repo: string, commit: string): Promise<boolean> {
  return (await git(repo, ["cat-file", "-e", `${commit}^{commit}`])).ok;
}

function fingerprint(repo: string, xy: string, path: string): string {
  try {
    const s = statSync(join(repo, path));
    return `${xy} ${s.size} ${s.mtimeMs}`;
  } catch {
    return `${xy} gone`;
  }
}

/** The repo's dirty files, each with a fingerprint; `{}` outside a git repository. */
export async function statusSnapshot(repo: string): Promise<Snapshot> {
  const r = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const snap: Snapshot = {};
  if (!r.ok) return snap;
  for (const { xy, path } of parsePorcelainZ(r.out)) snap[path] = fingerprint(repo, xy, path);
  return snap;
}

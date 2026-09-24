import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ReplyStatus } from "../types.ts";

const STATUS = /^STATUS:\s*(complete|partial|blocked|refused)\s*(?:—|–|-)\s*(.*)$/;

/** Dirs never worth hashing, even under an owned path. */
const SKIP = new Set(["node_modules", ".git", "dist", ".next", "coverage"]);

export function parseReplyStatus(reply: string): { status: ReplyStatus | null; why: string | null } {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const m = STATUS.exec(last);
  return m ? { status: m[1] as ReplyStatus, why: (m[2] ?? "").trim() } : { status: null, why: null };
}

function hashFile(path: string): string {
  return new Bun.CryptoHasher("sha1").update(readFileSync(path)).digest("hex");
}

/** Owned paths are matched literally: walked with node:fs, never interpreted as glob patterns. */
function walk(root: string, dir: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.set(relative(root, full), hashFile(full));
  }
}

export function snapshotOwned(repo: string, owned: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of owned) {
    const full = join(repo, o);
    if (!existsSync(full)) {
      m.set(o, "<absent>");
      continue;
    }
    if (statSync(full).isDirectory()) walk(repo, full, m);
    else m.set(o, hashFile(full));
  }
  return m;
}

export function changedSince(repo: string, before: Map<string, string>, owned: string[]): string[] {
  const after = snapshotOwned(repo, owned);
  const changed = new Set<string>();
  for (const [p, h] of after) {
    if (before.get(p) !== h && !(h === "<absent>" && !before.has(p))) changed.add(p);
  }
  for (const [p, h] of before) {
    if (!after.has(p) && h !== "<absent>") changed.add(p);
  }
  return [...changed].sort();
}

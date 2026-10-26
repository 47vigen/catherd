import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "../infra/store.ts";
import type { Run } from "./run-store.ts";

/** A finding in a brief is cut past this many characters (plan 44 D7). */
export const FINDING_MAX = 2_000;

const TITLE_MAX = 160;

/**
 * `text` cut to `max` characters when longer, its whole text kept once in `notes/<first 12 hex of sha256>.md` of the
 * run folder and named in the cut: the same text always lands in the same file.
 */
export function capText(run: Run, text: string, max: number): string {
  if (text.length <= max) return text;
  const id = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
  const rel = `notes/${id}.md`;
  const file = join(run.dir, rel);
  if (!existsSync(file)) writeTextAtomic(file, text);
  return `${text.slice(0, max)}\n[… cut: the whole text is in ${rel} (catherd run-file read ${run.id} ${rel})]`;
}

/** A known issue as a brief names it: its first line, at most 160 characters. */
export function issueTitle(text: string): string {
  const first = (text.split("\n")[0] ?? "").trim();
  return first.length <= TITLE_MAX ? first : `${first.slice(0, TITLE_MAX - 1)}…`;
}

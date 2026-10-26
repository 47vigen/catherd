import { existsSync } from "node:fs";
import { join } from "node:path";
import { cutText } from "../domain/util.ts";
import { writeTextAtomic } from "../infra/store.ts";
import type { Run } from "./run-store.ts";

/** A finding in a brief is cut past this many bytes (plan 44 D7). */
export const FINDING_MAX = 2_000;

const TITLE_MAX = 160;

/**
 * `text` cut to `max` bytes of UTF-8 when longer (whole lines, a code fence closed), its whole text kept once in
 * `notes/<first 12 hex of sha256>.md` of the run folder and named in the cut: the same text always lands in the same file.
 */
export function capText(run: Run, text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const id = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
  const rel = `notes/${id}.md`;
  const file = join(run.dir, rel);
  if (!existsSync(file)) writeTextAtomic(file, text);
  return `${cutText(text, max)}\n[… cut: the whole text is in ${rel} (catherd run-file read ${run.id} ${rel})]`;
}

/** A known issue as a brief names it: its first line, at most 160 characters. */
export function issueTitle(text: string): string {
  const first = (text.split("\n")[0] ?? "").trim();
  return first.length <= TITLE_MAX ? first : `${first.slice(0, TITLE_MAX - 1)}…`;
}

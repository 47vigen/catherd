import type { Finding } from "./run-events.ts";

const LINE = /^\s*(?:[-*]\s+|\d+[.)]\s+)?\**(BLOCKER|BUG|NIT)\b\**\s*:?\s*(.*)$/;
/** What a reviewer writes where it has nothing to report: `BUG: none`, `NIT n/a`, a lone dash. */
const NOTHING = /^(?:none|n\/a|nil|no findings?|clean|[-—–]+)\.?\**$/i;
const PATH = /^[`'"(]*((?:\.{0,2}\/)?[\w@~.+-]+(?:\/[\w@~.+-]+)*)(?::\d+(?:[-:]\d+)?)?[`'"),;:]*$/;

/**
 * The first `path:line` or `path` token of a finding's first words (a reviewer writes
 * `BLOCKER file:line — problem — fix`), or null: a path has a `/` or an extension.
 */
export function fileOf(text: string): string | null {
  for (const tok of text.trim().split(/\s+/).slice(0, 4)) {
    if (/^[—–-]+$/.test(tok)) return null;
    const p = PATH.exec(tok)?.[1];
    if (p && (p.includes("/") || /\.[A-Za-z]\w*$/.test(p))) return p;
  }
  return null;
}

/** A reviewer's reply as findings, in order: its BLOCKER, BUG and NIT lines, as written; "none" lines left out. */
export function parseFindings(reply: string): Finding[] {
  const out: Finding[] = [];
  for (const line of reply.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const rest = (m[2] ?? "").trim();
    if (!rest || NOTHING.test(rest)) continue;
    out.push({ label: m[1] as Finding["label"], text: line.trim(), file: fileOf(rest) });
  }
  return out;
}

/** The lines a failing verifier lists below its VERDICT line, as BLOCKERs: what the next fix round starts from. */
export function parseFailLines(reply: string, max = 12): Finding[] {
  const lines = reply.split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => l !== "");
  return lines
    .slice(at + 1)
    .filter((l) => l !== "" && !/^STATUS:/i.test(l))
    .slice(0, max)
    .map((l) => ({
      label: "BLOCKER" as const,
      text: l.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, ""),
      file: fileOf(l.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "").replace(/^\**FAIL\**:?\s*/i, "")),
    }));
}

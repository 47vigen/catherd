import type { Finding } from "./run-events.ts";

const LINE = /^\s*(?:[-*]\s+|\d+[.)]\s+)?\**(BLOCKER|BUG|NIT)\b\**\s*:?\s*(.*)$/;
/** What a reviewer writes where it has nothing to report: `BUG: none`, `NIT n/a`, a lone dash. */
const NOTHING = /^(?:none|n\/a|nil|no findings?|clean|[-—–]+)\.?\**$/i;
const PATH = /^[`'"(]*((?:\.{0,2}\/)?[\w@~.+-]+(?:\/[\w@~.+-]+)*)(?::[L~]?\d+(?:[-,:][L~]?\d+)*)?[`'"),;:]*$/;
/** A verifier's failing line after its list marker and bold: `FAIL`, `BLOCKER`, `BUG` or `A<n> … FAIL`. */
const FAIL_LINE = /^(?:[-*]\s+|\d+[.)]\s+)?\**(?:(?:FAIL|BLOCKER|BUG)\b|A\d+\b.*\bFAIL\b)/;

/**
 * Every file a text names, in order: `path`, `path:12`, `path:12-20`, `path:L12`, `path:~12`, `path:1,2,3`. A
 * path has a `/` or an extension; a leading `/` with no extension (`/models`) is a route, not a file.
 */
export function filesOf(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .flatMap((tok) => {
      const p = PATH.exec(tok)?.[1];
      return p && (/\.[A-Za-z]\w*$/.test(p) || (p.includes("/") && !p.startsWith("/"))) ? [p] : [];
    });
}

/** The first file a finding's text names, or null. */
export function fileOf(text: string): string | null {
  return filesOf(text)[0] ?? null;
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

/** The failing lines under a verifier's VERDICT, as BLOCKERs: what the next fix round starts from. */
export function parseFailLines(reply: string): Finding[] {
  const lines = reply.split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => l !== "");
  return lines
    .slice(at + 1)
    .filter((l) => FAIL_LINE.test(l))
    .map((l) => {
      const text = l.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "");
      return { label: "BLOCKER" as const, text, file: fileOf(text) };
    });
}

/**
 * A FAIL verdict that lists no FAIL, BLOCKER or BUG line: one BLOCKER quoting the first line it said that
 * names a file, else its first line.
 */
export function unlistedFail(reply: string): Finding {
  const said = reply
    .split("\n")
    .map((l) => l.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/, ""))
    .filter((l) => l && !/^(?:VERDICT|STATUS|HEAD):|^\*\*[^*]+\*\*:?$/i.test(l))
    .filter((l) => !/\bPASS\b/.test(l) || /fail/i.test(l));
  const line = said.find((l) => fileOf(l)) ?? said[0] ?? "";
  return {
    label: "BLOCKER",
    text: `verifier FAIL listed no failing line: ${line || "nothing after the verdict"}`,
    file: fileOf(line),
  };
}

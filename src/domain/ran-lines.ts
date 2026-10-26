/** The commands a verifier must run, and the RAN lines it answers with (plan 44 D8). */

const unquote = (s: string): string =>
  s
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
const collapse = (s: string): string => s.trim().replace(/\s+/g, " ");

/** A line's text after an optional list marker and a bold `TAG:` label, else null. */
const labelled = (tag: string, line: string): string | null =>
  new RegExp(`^\\s*(?:[-*+]\\s+)?\\*{0,2}${tag}:\\*{0,2}\\s*(.+?)\\s*$`).exec(line)?.[1] ?? null;

/** `RUN: <command>` lines of a verifier brief. */
export function parseRunLines(brief: string): string[] {
  return brief
    .split("\n")
    .map((l) => labelled("RUN", l))
    .filter((c): c is string => c !== null)
    .map(unquote)
    .filter(Boolean);
}

export interface RanLine {
  command: string;
  exit: number | null;
  log: string | null;
}

const RAN_BODY = /^(.*?)\s+[—–-]\s+(?:exit:?\s*(-?\d+)|NOT RUN(?:\s*\([^)]*\))?)(?:\s+[—–-]\s+(.*))?$/;

/** `RAN: <command> — exit <n> — <log>` lines of a reply; `NOT RUN` in place of the exit is `exit: null`. */
export function parseRanLines(reply: string): RanLine[] {
  const lines: RanLine[] = [];
  for (const raw of reply.split("\n")) {
    const m = RAN_BODY.exec(labelled("RAN", raw) ?? "");
    if (!m) continue;
    lines.push({
      command: unquote(m[1] as string),
      exit: m[2] === undefined ? null : Number(m[2]),
      log: m[3] ? unquote(m[3]) || null : null,
    });
  }
  return lines;
}

/** One `FAIL <command>: …` line per required command the RAN lines do not show run, clean and logged. */
export function verifierShortfall(
  required: string[],
  ran: readonly RanLine[],
  logOk: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const command of required) {
    const line = ran.findLast((r) => collapse(r.command) === collapse(command));
    const why =
      !line || line.exit === null
        ? "NOT RUN (no RAN line)"
        : line.exit !== 0
          ? `exit ${line.exit}`
          : !line.log
            ? "log missing or empty"
            : logOk(line.log)
              ? null
              : `log ${line.log} missing or empty`;
    if (why) out.push(`FAIL ${command}: ${why}`);
  }
  return out;
}

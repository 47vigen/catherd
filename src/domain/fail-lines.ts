const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The lines of a check's output that name a failure, stripped of colour, timings and counters so two runs compare
 * equal: at most 60 lines of at most 300 characters (t3herd `failLines`).
 */
export function checkFailLines(out: string): string[] {
  const seen = new Set<string>();
  for (const raw of out.split("\n")) {
    const line = raw
      .replace(ANSI, "")
      .replace(/\s*[[(]\s*\d+(\.\d+)?\s*(ms|s|m)\s*[\])]/g, "")
      .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "")
      .trim();
    const vuln = line.match(/^Vulnerability #\d+: (GO-\d{4}-\d+)/)?.[1];
    if (vuln) seen.add(`vulnerability ${vuln}`);
    else if (/(^|\s)(FAIL|FAILED|✗|✕|×)(\s|:|$)|^\(fail\)|^--- FAIL|^not ok\b|\bpanic:|^error:/.test(line))
      seen.add(line.slice(0, 300));
    if (seen.size >= 60) break;
  }
  return [...seen];
}

/** The lines of `fails` the base does not have; all of them when there is no base record. */
export const newFails = (fails: string[], base: string[] | null): string[] =>
  fails.filter((f) => !base?.includes(f));

/** The part of a shell `command` after its first `&&`, which may never run when an earlier part fails; null without one. */
// shortcut: a plain split, blind to quoting and `||`; split per shell grammar if a quoted `&&` ever misleads
export function andTail(command: string): string | null {
  const i = command.indexOf("&&");
  const tail = i < 0 ? "" : command.slice(i + 2).trim();
  return tail || null;
}

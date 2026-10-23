const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export const FAIL_DISPLAY_CAP = 60;

/** Replace run-specific details before comparing failures across checks. */
export function normalizeFailLine(line: string): string {
  return line
    .replace(ANSI, "")
    .replace(/\s*[[(]\s*\d+(\.\d+)?\s*(ms|s|m)\s*[\])]/g, "")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "")
    .replace(
      /\b(?:worker|verifier|reviewer|ui-reviewer|architect|writer|researcher|artist|judge)-M\d+(?:\.L\d+)?\b/g,
      "<role>",
    )
    .replace(/\b\d{8}-\d{6}(?:-[a-zA-Z0-9]+)+\b/g, "<run>")
    .replace(/(?<![\w/])(?:\/(?:var\/)?tmp\/)[^\s"'`<>()[\]{},;:]+/g, "<tmp>")
    .replace(/(?<![\w/])\/[^\s"'`<>()[\]{},;:]+/g, "<path>")
    .replace(/(:|\bport\s+)\d{2,5}\b/gi, "$1<port>")
    .trim();
}

/**
 * The lines of a check's output that name a failure, stripped of colour, timings and counters so two runs compare
 * equal: every distinct failure, at most 300 characters per line.
 */
export function checkFailLines(out: string): string[] {
  const seen = new Set<string>();
  for (const raw of out.split("\n")) {
    const line = normalizeFailLine(raw);
    const vuln = line.match(/^Vulnerability #\d+: (GO-\d{4}-\d+)/)?.[1];
    if (vuln) seen.add(`vulnerability ${vuln}`);
    else if (/(^|\s)(FAIL|FAILED|✗|✕|×)(\s|:|$)|^\(fail\)|^--- FAIL|^not ok\b|\bpanic:|^error:/.test(line))
      seen.add(line.slice(0, 300));
  }
  return [...seen];
}

/** The lines of `fails` the base does not have; all of them when there is no base record. */
export const newFails = (fails: string[], base: string[] | null): string[] =>
  fails.filter((f) => !base?.includes(f));

/** Top-level `&&` parts, keeping quoted strings and subshells intact. */
export function checkItems(command: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "&" && command[i + 1] === "&" && depth === 0) {
      items.push(command.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  items.push(command.slice(start).trim());
  return items;
}

/** The check items after the first one, which may never run when an earlier part fails. */
export function andTail(command: string): string | null {
  return checkItems(command).slice(1).join(" && ") || null;
}

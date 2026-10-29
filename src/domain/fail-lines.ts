import { CatherdError } from "./errors.ts";
import { filesOf } from "./findings.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export const FAIL_DISPLAY_CAP = 60;

/**
 * Replace run-specific details before comparing failures across checks. A path under one of `roots` (the trees the
 * check ran in) keeps its repo-relative part, so two different files never collapse to one `<path>`.
 */
export function normalizeFailLine(line: string, roots: readonly string[] = []): string {
  let out = line.replace(ANSI, "");
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const dir = root.replace(/\/+$/, "");
    if (dir) out = out.split(`${dir}/`).join("");
  }
  return out
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

/** A passing test line: a pass marker first, after an optional `<package> <script>:` prefix. */
export const PASS_LINE = /^(?:(?!FAIL\b)\S+ \S+:\s*)?(?:\(pass\)|[✓✔√]|ok\b|--- PASS|PASS\b)/;

/**
 * The lines of a check's output that name a failure, stripped of colour, timings and counters so two runs compare
 * equal: every distinct failure, at most 300 characters per line. A passing line never counts.
 */
export function checkFailLines(out: string, roots: readonly string[] = []): string[] {
  const seen = new Set<string>();
  for (const raw of out.split("\n")) {
    const line = normalizeFailLine(raw, roots);
    const vuln = line.match(/^Vulnerability #\d+: (GO-\d{4}-\d+)/)?.[1];
    if (vuln) seen.add(`vulnerability ${vuln}`);
    else if (PASS_LINE.test(line)) continue;
    else if (/(^|\s)(FAIL|FAILED|✗|✕|×)(\s|:|$)|^\(fail\)|^--- FAIL|^not ok\b|\bpanic:|^error:/.test(line))
      seen.add(line.slice(0, 300));
  }
  return [...seen];
}

const BUN_HEADER = /^(\S+\.(?:test|spec)\.\w+):$/;

/**
 * The repo files each fail line of `out` names: the output is cut into blocks that end at each `(pass)` or
 * `(fail)` line, and a block's files are the last bun file header seen, then every path the block names (an
 * absolute one under `root` made relative, `node_modules` and other absolute paths dropped).
 */
// shortcut: blocks follow bun's layout; another runner gets the paths its lines name, upgrade when a second runner needs headers
export function failFiles(out: string, root: string): Record<string, string[]> {
  const base = `${root.replace(/\/+$/, "")}/`;
  const result: Record<string, string[]> = {};
  let header: string | null = null;
  let block: string[] = [];
  const flush = () => {
    const text = block.join("\n");
    block = [];
    const lines = checkFailLines(text);
    if (!lines.length) return;
    const paths = [...(header ? [header] : []), ...filesOf(text)]
      .map((p) => (p.startsWith(base) ? p.slice(base.length) : p.replace(/^\.\//, "")))
      .filter((p) => !p.startsWith("/") && !p.split("/").includes("node_modules"));
    for (const line of lines) result[line] = [...new Set([...(result[line] ?? []), ...paths])];
  };
  for (const raw of out.replace(ANSI, "").split("\n")) {
    block.push(raw);
    const h = BUN_HEADER.exec(raw.trim())?.[1];
    if (h) header = h;
    if (/^\s*\((?:pass|fail)\)/.test(raw)) flush();
  }
  flush();
  return Object.fromEntries(Object.entries(result).filter(([, files]) => files.length));
}

/** The lines of `fails` the base does not have; all of them when there is no base record. */
export const newFails = (fails: string[], base: string[] | null): string[] =>
  fails.filter((f) => !base?.includes(f));

/** Plan 52: a check's result against the same command on the base. */
export type CheckVerdict = "pass" | "inherited" | "new" | "unknown";

/** A failing line that names only a file or a package (jest `FAIL path`, Go `FAIL\tpkg`, a bare `FAIL`). */
const FILE_LEVEL = /^FAIL(\s+\S+)?(\s+\[[^\]]*\])?$/;

/** A runner's exit summary (bun script, npm/pnpm/yarn, make): it says a command failed, never what failed. */
const WRAPPER_LINE =
  /^error: (?:script )?"[^"]*" exited with code \d+|\bELIFECYCLE\b|\bCommand failed with exit code \d+|^make(?:\[\d+\])?: \*\*\* .*\bError \d+/;

/**
 * Plan 52: `inherited` when the base fails every line this check fails, with the same exit, on sides that can be
 * compared (`comparable: false`: output cut, or a part before the last of an `&&` chain failed) and with no line
 * that names only a file or package. `new` when a line is not on the base or the base passed. `unknown` with no
 * base result, on a timeout, with no line to read, or when any of the above says the sets cannot be compared. A runner's exit summary (`error: script ...`) is
 * not a failing line: a side with only those is `unknown`, and they are ignored beside real lines.
 */
export function checkVerdict(
  exit: number | null,
  failures: readonly string[],
  base: { exit: number | null; failures: readonly string[]; comparable?: boolean } | null,
  o: { comparable?: boolean } = {},
): CheckVerdict {
  if (exit === 0) return "pass";
  if (base === null || exit === null) return "unknown";
  if (base.exit === 0) return "new";
  // a wrapper line proves nothing: with no test-level line on either side, the diagnostics were never compared
  const lines = failures.filter((f) => !WRAPPER_LINE.test(f));
  if (lines.length === 0 || !base.failures.some((f) => !WRAPPER_LINE.test(f))) return "unknown";
  if (!lines.every((f) => base.failures.includes(f))) return "new";
  const same = base.exit === exit && base.comparable !== false && o.comparable !== false;
  return same && !lines.some((f) => FILE_LEVEL.test(f)) ? "inherited" : "unknown";
}

/** A part that is exactly `cd <dir>`: the shell runs every part after it in that folder. */
const BARE_CD = /^cd\s+("[^"]*"|'[^']*'|\S+)$/;

/**
 * Top-level `&&` parts, keeping quoted strings and subshells intact. A bare `cd <dir>` part joins every part after
 * it, since the shell runs them in `<dir>`.
 */
export function checkItems(command: string): string[] {
  const items: string[] = [];
  let start = 0;
  let cdStart = -1;
  const contexts: (string | null)[] = [];
  const blocks: { close: string; pattern?: boolean; header?: boolean }[] = [];
  let quote: string | null = null;
  let word = "";
  let commandPosition = true;
  const whole = () => [command.trim()];
  const addItem = (end: number) => {
    const item = command.slice(start, end).trim();
    if (!item)
      throw new CatherdError("E_INPUT_INVALID", "empty check item", {
        fix: "provide a command on both sides of every top-level &&",
      });
    if (cdStart >= 0) return;
    if (BARE_CD.test(item)) cdStart = start;
    else items.push(item);
  };
  const endWord = (): boolean => {
    if (!word) return true;
    const token = word;
    word = "";
    const block = blocks.at(-1);
    if (block?.close === "]]") {
      if (token === "]]") blocks.pop();
      return true;
    }
    if (block?.header) {
      if (token === "in") {
        block.header = false;
        block.pattern = true;
      }
      return true;
    }
    if (block?.pattern) {
      if (token !== "esac") return true;
      commandPosition = true;
    }
    if (!commandPosition) return true;
    commandPosition = false;
    // Unsupported time options may precede a compound command.
    if (token === "time") return false;
    if (["fi", "done", "esac", "}", "]]"].includes(token)) {
      if (block?.close !== token) return false;
      blocks.pop();
    } else if (["if", "while", "until", "for", "select", "case", "{", "[["].includes(token)) {
      const close =
        token === "if"
          ? "fi"
          : token === "case"
            ? "esac"
            : token === "{"
              ? "}"
              : token === "[["
                ? "]]"
                : "done";
      blocks.push({ close, ...(token === "case" ? { header: true } : {}) });
      commandPosition = ["if", "while", "until", "{"].includes(token);
    } else if (["then", "elif", "else", "do"].includes(token)) {
      if (block?.close !== (token === "do" ? "done" : "fi")) return false;
      commandPosition = true;
    } else if (token === "!") commandPosition = true;
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (char === "\\" && quote !== "'") {
      if (i + 1 === command.length) return whole();
      if (!contexts.length) word += command.slice(i, i + 2);
      i++;
      continue;
    }
    // Parameter expansion syntax can contain operators and nested shell syntax.
    if (char === "$" && command[i + 1] === "{" && !quote) return whole();
    if (char === "$" && command[i + 1] === "(" && quote !== "'" && quote !== "`") {
      if (!contexts.length) word += "$(...)";
      contexts.push(quote);
      quote = null;
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      if (!contexts.length) word += char;
      quote = char;
      continue;
    }
    if (contexts.length) {
      if (char === "(") contexts.push(null);
      else if (char === ")") quote = contexts.pop() ?? null;
      continue;
    }
    if (/\s/.test(char)) {
      if (!endWord()) return whole();
      if (char === "\n" && blocks.at(-1)?.close !== "]]") commandPosition = true;
      continue;
    }
    if (char === "#" && !word && blocks.at(-1)?.close !== "]]") return whole();
    if (char === "<" && command[i + 1] === "<") {
      if (command[i + 2] !== "<") return whole();
      if (!endWord()) return whole();
      i += 2;
      continue;
    }
    if ("();&|<>".includes(char)) {
      if (!endWord()) return whole();
      const block = blocks.at(-1);
      if (block?.close === "]]") continue;
      // A case pattern ends with a bare parenthesis, not a subshell closer.
      if (block?.pattern) {
        if (char === ")") {
          block.pattern = false;
          commandPosition = true;
        }
        continue;
      }
      if (char === "(") {
        contexts.push(null);
        commandPosition = false;
      } else if (char === ")") return whole();
      else if (char === "&" && command[i + 1] === "&") {
        if (!blocks.length) {
          addItem(i);
          start = i + 2;
        }
        commandPosition = true;
        i++;
      } else if (";&|".includes(char)) {
        commandPosition = true;
        if (char === ";" && command[i + 1] === ";" && block?.close === "esac") {
          block.pattern = true;
          i++;
        }
      }
      continue;
    }
    word += char;
  }
  if (!endWord() || quote || contexts.length || blocks.length) return whole();
  addItem(command.length);
  if (cdStart >= 0) items.push(command.slice(cdStart).trim());
  return items;
}

/** The folder a check item runs in, as `d/`: `cd d && …`, or one `(cd d && …)` group. Null: the whole tree. */
export function coveredDir(item: string): string | null {
  const head = /^(\(?)cd (\w[\w.+@-]*(?:\/\w[\w.+@-]*)*)\/?\s*&&/.exec(item);
  if (!head) return null;
  let rest = item.slice(head[0].length);
  // A group must be the whole item, with no other group in it.
  if (head[1]) {
    if (!rest.endsWith(")") || /[()]/.test(rest.slice(0, -1))) return null;
    rest = rest.slice(0, -1);
  }
  // shortcut: a sourced file or function can still leave the folder, upgrade to a shell parser when one does
  return /\b(?:cd|pushd|popd)\b/.test(rest) ? null : `${head[2]}/`;
}

/** The check items after the first one, which may never run when an earlier part fails. */
export function andTail(command: string): string | null {
  return checkItems(command).slice(1).join(" && ") || null;
}

/**
 * Plan 52: `command` with `mark` run after every top-level `&&` part but the last, so the marks that ran say which
 * part failed (marks = parts - 1: the last part failed). `tracked` is false when the marks cannot be trusted: a `||`
 * anywhere can run a later part after an earlier one failed.
 */
export function markParts(
  command: string,
  mark: string,
): { script: string; parts: number; tracked: boolean } {
  let items: string[];
  try {
    items = checkItems(command).flatMap(splitLeadingCd);
  } catch {
    items = [command.trim()];
  }
  const tracked = items.length === 1 || !command.includes("||");
  return { script: tracked ? items.join(` && ${mark} && `) : command, parts: items.length, tracked };
}

/** `cd d && a && b` as `cd d && a`, `b`: the script is one shell, so the cd still applies to what follows. */
function splitLeadingCd(item: string): string[] {
  const head = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/.exec(item);
  if (!head) return [item];
  const [first, ...rest] = checkItems(item.slice(head[0].length));
  return first === undefined ? [item] : [`${head[0]}${first}`, ...rest];
}

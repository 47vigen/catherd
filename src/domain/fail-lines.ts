import { CatherdError } from "./errors.ts";

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
    items.push(item);
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
  return items;
}

/** The check items after the first one, which may never run when an earlier part fails. */
export function andTail(command: string): string | null {
  return checkItems(command).slice(1).join(" && ") || null;
}

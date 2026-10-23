import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "../adapters/registry.ts";
import type { TranscriptItem, TranscriptPage } from "../domain/transcript.ts";
import { log } from "../infra/log.ts";

/** The complete lines of `<dir>/events.jsonl`: a last line with no "\n" is still being written and is left out. */
function completeLines(dir: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

function linesFrom(dir: string, at: number): { lines: string[]; at: number } {
  let fd: number;
  try {
    fd = openSync(join(dir, "events.jsonl"), "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], at };
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < at) return { lines: [], at: 0 };
    if (size === at) return { lines: [], at };
    const buf = Buffer.alloc(size - at);
    const read = readSync(fd, buf, 0, buf.length, at);
    const end = buf.subarray(0, read).lastIndexOf(10);
    if (end < 0) return { lines: [], at };
    return { lines: buf.subarray(0, end).toString("utf8").split("\n"), at: at + end + 1 };
  } finally {
    closeSync(fd);
  }
}

/** `claude` is the native pseudo-backend; it reads with claude-code's parser. */
const parserFor = (backend: string) => adapterFor(backend === "claude" ? "claude-code" : backend)?.transcript;

function itemsOf(backend: string, lines: string[], from: number): TranscriptItem[] {
  const parse = parserFor(backend);
  return lines.flatMap((text, i) =>
    parse ? parse(text, from + i) : text.trim() ? [{ kind: "raw" as const, line: from + i, text }] : [],
  );
}

// shortcut: reads the whole stream per page, upgrade past ~50 MB streams
export function readTranscript(
  dir: string,
  backend: string,
  o: { from: number; limit: number; raw: boolean; ended: boolean },
): TranscriptPage {
  const page = completeLines(dir).slice(o.from, o.from + o.limit);
  return {
    items: o.raw ? [] : itemsOf(backend, page, o.from),
    raw: o.raw ? page.filter((l) => l.trim()) : null,
    next: o.from + page.length,
    ended: o.ended,
  };
}

const TAIL_PAGE = 500;

/** Calls `onPage` with each batch of lines appended after line `from`, until the returned stop is called. */
export function tailTranscript(
  dir: string,
  backend: string,
  from: number,
  onPage: (p: { items: TranscriptItem[]; raw: string[]; next: number }) => void,
  o: { pollMs?: number } = {},
): () => void {
  let next = from;
  let offset = 0;
  let line = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = (): void => {
    if (stopped) return;
    try {
      let r = linesFrom(dir, offset);
      if (r.at < offset) {
        offset = 0;
        line = 0;
        r = linesFrom(dir, offset);
      }
      const lines = r.lines.slice(Math.max(0, next - line));
      let at = Math.max(next, line);
      for (let i = 0; !stopped && i < lines.length; i += TAIL_PAGE) {
        const page = lines.slice(i, i + TAIL_PAGE);
        next = at + page.length;
        onPage({ items: itemsOf(backend, page, at), raw: page.filter((l) => l.trim()), next });
        at = next;
      }
      offset = r.at;
      line += r.lines.length;
    } catch (err) {
      log("warn", "transcript", { dir, tail: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(poll, o.pollMs ?? 500);
  };
  poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

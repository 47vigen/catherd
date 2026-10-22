import { readFileSync } from "node:fs";
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
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = (): void => {
    if (stopped) return;
    try {
      const lines = completeLines(dir);
      while (!stopped && next < lines.length) {
        const page = lines.slice(next, next + TAIL_PAGE);
        const at = next;
        next += page.length;
        onPage({ items: itemsOf(backend, page, at), raw: page.filter((l) => l.trim()), next });
      }
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

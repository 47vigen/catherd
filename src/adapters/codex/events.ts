import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface CodexFold {
  thread: string | null;
  tokens: Tokens;
  turnFailed: boolean;
  failure: string | null;
  limit: boolean;
  tooOld: boolean;
  lastEvent: string | null;
}

export const CODEX_LIMIT = [/usage limit/i, /rate limit reached/i, /quota exceeded/i, /try again later/i];
export const CODEX_TOO_OLD = [/not supported when using Codex with a ChatGPT account/i];

type Event = Record<string, any>;

export function parseCodexLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    return JSON.parse(line) as Event;
  } catch {
    return null;
  }
}

/** Only `turn.failed` fails a run: an `error` event mid-stream is a transient reconnect. */
export function foldCodexEvents(lines: string[]): CodexFold {
  const f: CodexFold = {
    thread: null,
    tokens: { ...ZERO_TOKENS },
    turnFailed: false,
    failure: null,
    limit: false,
    tooOld: false,
    lastEvent: null,
  };
  for (const line of lines) {
    const e = parseCodexLine(line);
    if (!e) continue;
    f.lastEvent = e.item?.type ? `${e.type}/${e.item.type}` : e.type;
    const msg: string = e.message ?? e.error?.message ?? e.item?.message ?? "";
    if (CODEX_TOO_OLD.some((r) => r.test(msg))) f.tooOld = true;
    if (e.type === "thread.started") f.thread = e.thread_id ?? null;
    else if (e.type === "turn.completed" && e.usage) {
      f.tokens.input += e.usage.input_tokens ?? 0;
      f.tokens.cached += e.usage.cached_input_tokens ?? 0;
      f.tokens.output += e.usage.output_tokens ?? 0;
    } else if (e.type === "turn.failed") {
      f.turnFailed = true;
      f.failure = msg || "turn failed";
      if (CODEX_LIMIT.some((r) => r.test(msg))) f.limit = true;
    }
  }
  return f;
}

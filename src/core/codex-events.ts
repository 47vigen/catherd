import type { Tokens } from "../types.ts";

export interface CodexParse {
  thread: string | null;
  tokens: Tokens;
  turnFailed: boolean;
  failure: string | null;
  limit: boolean;
  cliTooOld: boolean;
  lastEvent: string | null;
}

const LIMIT = /usage limit|rate limit reached|quota exceeded|try again later/i;
const TOO_OLD = /not supported when using Codex with a ChatGPT account/i;

export function parseCodexEvents(lines: string[]): CodexParse {
  const p: CodexParse = {
    thread: null,
    tokens: { input: 0, cached: 0, output: 0 },
    turnFailed: false,
    failure: null,
    limit: false,
    cliTooOld: false,
    lastEvent: null,
  };
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    p.lastEvent = e.item?.type ? `${e.type}/${e.item.type}` : e.type;
    const msg: string = e.message ?? e.error?.message ?? e.item?.message ?? "";
    if (TOO_OLD.test(msg)) p.cliTooOld = true;
    if (e.type === "thread.started") p.thread = e.thread_id ?? null;
    else if (e.type === "turn.completed" && e.usage) {
      p.tokens.input += e.usage.input_tokens ?? 0;
      p.tokens.cached += e.usage.cached_input_tokens ?? 0;
      p.tokens.output += e.usage.output_tokens ?? 0;
    } else if (e.type === "turn.failed") {
      p.turnFailed = true;
      p.failure = msg || "turn failed";
      if (LIMIT.test(msg)) p.limit = true;
    }
  }
  return p;
}

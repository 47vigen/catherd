import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface CodexFold {
  thread: string | null;
  tokens: Tokens;
  turnFailed: boolean;
  failure: string | null;
  limit: boolean;
  tooOld: boolean;
  lastEvent: string | null;
  /** plan 22: the agent message that ended each completed turn, in order */
  finals: string[];
}

/**
 * An account limit, not any error that says "try again later" (an overloaded server does too). A rate
 * limit codex retried until it gave up reads "exceeded retry limit, last status: 429 Too Many Requests".
 */
export const CODEX_LIMIT = [
  /usage limit/i,
  /rate limit reached/i,
  /quota exceeded/i,
  /status: 429|too many requests/i,
];
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
    finals: [],
  };
  let said: string | null = null;
  for (const line of lines) {
    const e = parseCodexLine(line);
    if (!e) continue;
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string")
      said = e.item.text;
    if (e.type === "turn.completed" && said !== null) {
      f.finals.push(said);
      said = null;
    }
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

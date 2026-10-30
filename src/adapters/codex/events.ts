import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface CodexFold {
  thread: string | null;
  tokens: Tokens;
  turnFailed: boolean;
  failure: string | null;
  limit: boolean;
  /** plan 55: the account cannot use the rung's model, so the rung cannot run */
  modelUnavailable: boolean;
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
/**
 * plan 55: a model the account lost or never had reads "The 'X' model is not supported when using Codex with a
 * ChatGPT account" with code `model_not_found`. It says nothing about the CLI's age (the probe checks that).
 */
export const CODEX_MODEL_UNAVAILABLE = [
  /model_not_found/i,
  /model is not supported/i,
  /not supported when using Codex with a ChatGPT account/i,
];
/** Codex's own message never names an old CLI: the probe's version gate does. */
export const CODEX_TOO_OLD: RegExp[] = [];

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
    modelUnavailable: false,
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
    if (CODEX_MODEL_UNAVAILABLE.some((r) => r.test(msg))) f.modelUnavailable = true;
    if (e.type === "thread.started") f.thread = e.thread_id ?? null;
    else if (e.type === "turn.completed" && e.usage) {
      // plan 40: codex reports the thread's running total, so the last turn's usage is the whole of it
      f.tokens.input = e.usage.input_tokens ?? 0;
      f.tokens.cached = e.usage.cached_input_tokens ?? 0;
      f.tokens.output = e.usage.output_tokens ?? 0;
    } else if (e.type === "turn.failed") {
      f.turnFailed = true;
      f.failure = msg || "turn failed";
      if (CODEX_LIMIT.some((r) => r.test(msg))) f.limit = true;
    }
  }
  return f;
}

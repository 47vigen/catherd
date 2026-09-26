import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface ClaudeResult {
  isError: boolean;
  text: string;
  apiStatus: number | null;
  tokens: Tokens;
  costUsd: number | null;
}

export interface ClaudeFold {
  thread: string | null;
  result: ClaudeResult | null;
  limit: boolean;
  lastEvent: string | null;
}

/** A usage or rate limit, in the result text Claude Code prints. */
export const CLAUDE_LIMIT = [/usage limit/i, /hit your (?:usage )?limit/i, /rate[ _-]?limit/i];
/** What an older `claude` prints for a flag catherd passes (commander's messages). */
export const CLAUDE_TOO_OLD = [
  /unknown option '--/i,
  /option '--[\w-]+ <[\w.]+>' argument '[^']*' is invalid/i,
];

type Event = Record<string, any>;

export function parseClaudeLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) ? (e as Event) : null;
  } catch {
    return null;
  }
}

/** Spec §4.3's convention: input counts cached and freshly cached tokens too. */
export function claudeTokens(u: Event | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS };
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cache_read_input_tokens");
  return {
    input: n("input_tokens") + n("cache_creation_input_tokens") + cached,
    cached,
    output: n("output_tokens"),
  };
}

export function eventName(e: Event): string {
  if (e.type === "system") return e.subtype === "api_retry" ? "retrying" : `system/${e.subtype ?? "?"}`;
  if (e.type === "assistant") {
    const c = (e.message?.content ?? []).at(-1) as Event | undefined;
    return c?.type === "tool_use" ? `tool_use/${c.name}` : `assistant/${c?.type ?? "?"}`;
  }
  if (e.type === "user") return "tool_result";
  return String(e.type ?? "?");
}

const limited = (e: Event): boolean =>
  (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") ||
  (e.type === "assistant" && e.error === "rate_limit") ||
  (e.type === "result" &&
    e.is_error === true &&
    (e.api_error_status === 429 || CLAUDE_LIMIT.some((r) => r.test(String(e.result ?? "")))));

/** Tokens and cost come from the final `result` event only: assistant events repeat one message's usage. */
export function foldClaudeEvents(lines: string[]): ClaudeFold {
  const f: ClaudeFold = { thread: null, result: null, limit: false, lastEvent: null };
  for (const line of lines) {
    const e = parseClaudeLine(line);
    if (!e) continue;
    f.lastEvent = eventName(e);
    if (typeof e.session_id === "string" && e.session_id) f.thread ??= e.session_id;
    if (limited(e)) f.limit = true;
    if (e.type === "result")
      f.result = {
        isError: e.is_error === true,
        text: typeof e.result === "string" ? e.result : "",
        apiStatus: typeof e.api_error_status === "number" ? e.api_error_status : null,
        tokens: claudeTokens(e.usage),
        costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
      };
  }
  return f;
}

import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface GrokEnd {
  stopReason: string;
  thread: string | null;
  tokens: Tokens;
  /** only when the server reported the whole cost (API-key traffic); absent is unknown, never free */
  costUsd: number | null;
}

export interface GrokFold {
  /** the text after the last tool call: the worker's final message (spec 1.3 §5.5) */
  reply: string;
  end: GrokEnd | null;
  /** a terminal `error` event's message: a run that never started a turn prints one instead of `end` */
  error: string | null;
  /** the sum of the per-response `usage` events, for a stream with no `end` */
  used: Tokens;
  lastEvent: string | null;
}

/**
 * Research §3.10: the limit texts of the 1.0.44 binary ([bin] "rate limit for your plan", "free Grok Build
 * usage limit", "temporarily overloaded") and of the 2026-09-25 research's source read. Their apostrophes are
 * U+2019, so no pattern spells one.
 */
export const GROK_LIMIT = [
  /rate limit/i,
  /usage limit/i,
  /too many requests/i,
  /resource.exhausted/i,
  /at capacity/i,
  /temporarily overloaded/i,
];
/** A plan without Grok Build: no wait fixes it. */
export const GROK_NOT_LIMIT = [/requires a Grok subscription/i];
/** clap's error for a flag this grok does not know, exit 2 (research §3.3 [run]). */
export const GROK_TOO_OLD = [/unexpected argument '/i];
/** research §3.3 [run]: a logged-out run's one error event */
const GROK_AUTH = [/Not signed in/i];

type Event = Record<string, any>;

export function parseGrokLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) ? (e as Event) : null;
  } catch {
    return null;
  }
}

/** Spec 1.3 §5.5: `input_tokens` is uncached only (research §3.3), so input adds the cache reads and writes. */
export function grokTokens(u: Event | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS };
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cache_read_input_tokens");
  return {
    input: n("input_tokens") + cached + n("cache_creation_input_tokens"),
    cached,
    output: n("output_tokens"),
  };
}

export const isLimit = (text: string): boolean =>
  GROK_LIMIT.some((r) => r.test(text)) && !GROK_NOT_LIMIT.some((r) => r.test(text));
export const isTooOld = (text: string): boolean => GROK_TOO_OLD.some((r) => r.test(text));
export const isAuthFailure = (text: string): boolean => GROK_AUTH.some((r) => r.test(text));

export function eventName(e: Event): string {
  if (e.type === "tool_call") return `tool_call/${e.toolName ?? e.kind ?? "?"}`;
  if (e.type === "tool_call_update") return `tool_call_update/${e.status ?? "?"}`;
  return String(e.type ?? "?");
}

/** Spec §3.7: a command the worker runs, a file it reads or edits, or its message. */
export function grokActivity(e: Event): string | undefined {
  if (e.type === "text") return typeof e.data === "string" && e.data.trim() ? e.data : undefined;
  if (e.type !== "tool_call") return undefined;
  const input = (e.rawInput ?? {}) as Event;
  if (typeof input.command === "string") return `$ ${input.command}`;
  if (typeof input.path === "string") return `${e.kind === "read" ? "read" : "edit"} ${input.path}`;
  return String(e.title ?? e.toolName ?? "tool");
}

export function foldGrokEvents(lines: string[]): GrokFold {
  const f: GrokFold = { reply: "", end: null, error: null, used: { ...ZERO_TOKENS }, lastEvent: null };
  for (const line of lines) {
    const e = parseGrokLine(line);
    if (!e) continue;
    f.lastEvent = eventName(e);
    if (e.type === "tool_call" || e.type === "tool_call_update") f.reply = "";
    else if (e.type === "text" && typeof e.data === "string") f.reply += e.data;
    else if (e.type === "usage") {
      const t = grokTokens(e.usage);
      f.used = {
        input: f.used.input + t.input,
        cached: f.used.cached + t.cached,
        output: f.used.output + t.output,
      };
    } else if (e.type === "end")
      f.end = {
        stopReason: String(e.stopReason ?? "?"),
        thread: typeof e.sessionId === "string" && e.sessionId ? e.sessionId : null,
        tokens: e.usage ? grokTokens(e.usage) : f.used,
        costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
      };
    else if (e.type === "error") f.error = String(e.message ?? "error");
  }
  return f;
}

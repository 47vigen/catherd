import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface CursorResult {
  isError: boolean;
  text: string;
  tokens: Tokens;
}

export interface CursorFold {
  thread: string | null;
  /**
   * The assistant text after the last tool call, as Cursor's text format prints it; `result.result` runs every
   * segment together, which would bury the STATUS line (spec 1.3 §3.1, research §2.3). null: no assistant text.
   */
  reply: string | null;
  result: CursorResult | null;
  lastEvent: string | null;
}

/**
 * A usage or rate limit (research §2.3: `ActionRequiredError` and the server's codes; the user-facing text
 * comes from the server). A team policy looks like one but never passes by waiting (CURSOR_POLICY).
 */
export const CURSOR_LIMIT = [
  /usage limit/i,
  /rate limit/i,
  /too many requests/i,
  /ActionRequiredError/,
  /USAGE_LIMIT/,
  /RATE_LIMIT/,
];
export const CURSOR_POLICY = [/administrator has disabled/i];
/** What an older `cursor-agent` prints for a flag catherd passes (commander, exit 1), or the server's verdict. */
export const CURSOR_TOO_OLD = [/unknown option/i, /OUTDATED_CLIENT/];
/** research §2.2 [run]: no login and no CURSOR_API_KEY, on stderr, before any event */
const CURSOR_AUTH = [/Authentication required/i];

type Event = Record<string, any>;

export function parseCursorLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) ? (e as Event) : null;
  } catch {
    return null;
  }
}

/**
 * Spec §4.3's convention from `result.usage` (camelCase): `inputTokens` is uncached only (research §2.3,
 * `max(total - cacheRead - cacheWrite, 0)`), so input adds cache reads and writes back.
 */
export function cursorTokens(u: Event | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS };
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cacheReadTokens");
  return { input: n("inputTokens") + cached + n("cacheWriteTokens"), cached, output: n("outputTokens") };
}

const textOf = (e: Event): string =>
  ((e.message?.content ?? []) as Event[])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");

/** A tool call's tool: `readToolCall`, `writeToolCall`, or a `function`'s name. */
function toolOf(e: Event): { name: string; args: Event } {
  const [kind, call] = Object.entries((e.tool_call ?? {}) as Event)[0] ?? ["?", {}];
  if (kind !== "function") return { name: kind, args: (call?.args ?? {}) as Event };
  let args: Event = {};
  try {
    args = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : (call?.arguments ?? {});
  } catch {
    // arguments that are not JSON: the name alone
  }
  return { name: String(call?.name ?? "function"), args };
}

export function eventName(e: Event): string {
  if (e.type === "tool_call")
    return `tool_call/${e.subtype ?? "?"}/${Object.keys(e.tool_call ?? {})[0] ?? "?"}`;
  return e.subtype ? `${e.type}/${e.subtype}` : String(e.type ?? "?");
}

/** Spec §3.7: a command the worker runs, a file it reads or edits, or its message. */
export function cursorActivity(e: Event): string | undefined {
  if (e.type === "assistant") return textOf(e) || undefined;
  if (e.type !== "tool_call" || e.subtype !== "started") return undefined;
  const { name, args } = toolOf(e);
  if (typeof args.command === "string") return `$ ${args.command}`;
  if (typeof args.path === "string") return `${name === "readToolCall" ? "read" : "edit"} ${args.path}`;
  return name;
}

export const isLimit = (text: string): boolean =>
  CURSOR_LIMIT.some((r) => r.test(text)) && !CURSOR_POLICY.some((r) => r.test(text));
export const isTooOld = (text: string): boolean => CURSOR_TOO_OLD.some((r) => r.test(text));
export const isAuthFailure = (text: string): boolean => CURSOR_AUTH.some((r) => r.test(text));

export function foldCursorEvents(lines: string[]): CursorFold {
  const f: CursorFold = { thread: null, reply: null, result: null, lastEvent: null };
  for (const line of lines) {
    const e = parseCursorLine(line);
    if (!e) continue;
    f.lastEvent = eventName(e);
    if (typeof e.session_id === "string" && e.session_id) f.thread ??= e.session_id;
    if (e.type === "tool_call") f.reply = null;
    else if (e.type === "assistant") {
      const t = textOf(e);
      if (t) f.reply = (f.reply ?? "") + t;
    } else if (e.type === "result")
      f.result = {
        isError: e.is_error === true,
        text: typeof e.result === "string" ? e.result : "",
        tokens: cursorTokens(e.usage),
      };
  }
  return f;
}

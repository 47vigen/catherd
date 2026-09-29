import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface AgyResult {
  /** SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING or RUNNING (research §4.4) */
  status: string;
  /** the reply: the final message only (spec 1.3 §6.5; the live kit confirms it) */
  response: string;
  error: string;
  tokens: Tokens;
}

export interface AgyFold {
  thread: string | null;
  result: AgyResult | null;
  lastEvent: string | null;
}

/** A quota, spend cap or credits stop (spec 1.3 §6.5; research §4.4, §4.8: the texts are the changelog's). */
export const AGY_LIMIT = [/RESOURCE_EXHAUSTED/, /quota/i, /spend cap/i, /credits/i];
/** What an older agy prints for a flag catherd passes (Go `flag`, exit 2; research §4.4 [run]). */
export const AGY_TOO_OLD = [/flags? provided but not defined/i];
/** research §4.4 [run] (the logged-out result's error) and §4.5 [run] (`agy models` logged out) */
const AGY_AUTH = [/authentication failed/i, /please sign in/i];

type Event = Record<string, any>;

/** One stream line: an object keyed by `event` (research §4.4: `event`, not `type`); null for anything else. */
export function parseAgyLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) && typeof (e as Event).event === "string"
      ? (e as Event)
      : null;
  } catch {
    return null;
  }
}

/**
 * An event's payload: under the key its `event` names, as the logged-out `result` line has it (research §4.4
 * [run]), else the event itself (the headless doc lists the fields flat).
 */
export const bodyOf = (e: Event): Event => {
  const inner = e[e.event as string];
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Event) : e;
};

/**
 * Spec 1.3 §6.5: input as reported, cached = cache reads, output = output + thinking. Whether `input_tokens`
 * includes the cache reads is unverified (research §4.4): when the reads exceed it, it cannot, so they add back.
 * ponytail: a run whose uncached input happens to exceed its cache reads still undercounts; the live capture decides.
 */
export function agyTokens(u: Event | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS };
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cache_read_tokens");
  const input = n("input_tokens");
  return {
    input: cached > input ? input + cached : input,
    cached,
    output: n("output_tokens") + n("thinking_tokens"),
  };
}

export function eventName(e: Event): string {
  const b = bodyOf(e);
  if (e.event === "step_update") return `step_update/${b.step_type ?? "?"}/${b.state ?? "?"}`;
  if (e.event === "result") return `result/${b.status ?? "?"}`;
  return String(e.event);
}

/** Spec §3.7: a command the worker runs, a file it reads or edits, or its message. */
export function agyActivity(e: Event): string | undefined {
  if (e.event !== "step_update") return undefined;
  const b = bodyOf(e);
  if (b.step_type === "agent_response")
    return typeof b.text_delta === "string" && b.text_delta ? b.text_delta : undefined;
  if (b.step_type !== "tool" || b.state !== "ACTIVE") return undefined;
  const name = String(b.tool_name ?? "tool");
  const info = (b.tool_info ?? {}) as Event;
  if (typeof info.command === "string") return `$ ${info.command}`;
  const path = info.path ?? info.file_path;
  if (typeof path === "string") return `${/read|view/i.test(name) ? "read" : "edit"} ${path}`;
  return name;
}

/**
 * The `AGY_ERROR: {…}` line a model or agent failure prints on stderr (research §4.4: the canonical status,
 * the HTTP/gRPC code, retryability and an error id; the field names are unverified): its text, and its
 * `message` when it is JSON that has one.
 */
export function agyError(stderr: string): { text: string; message: string } | null {
  const line = stderr
    .split("\n")
    .findLast((l) => l.startsWith("AGY_ERROR:"))
    ?.slice("AGY_ERROR:".length)
    .trim();
  if (line === undefined) return null;
  try {
    const j = JSON.parse(line) as Event;
    const m = j?.message ?? j?.error?.message ?? j?.error;
    return { text: line, message: typeof m === "string" && m ? m : line };
  } catch {
    return { text: line, message: line };
  }
}

export const isLimit = (text: string): boolean => AGY_LIMIT.some((r) => r.test(text));
export const isTooOld = (text: string): boolean => AGY_TOO_OLD.some((r) => r.test(text));
export const isAuthFailure = (text: string): boolean => AGY_AUTH.some((r) => r.test(text));

export function foldAgyEvents(lines: string[]): AgyFold {
  const f: AgyFold = { thread: null, result: null, lastEvent: null };
  for (const line of lines) {
    const e = parseAgyLine(line);
    if (!e) continue;
    const b = bodyOf(e);
    f.lastEvent = eventName(e);
    if (typeof b.conversation_id === "string" && b.conversation_id) f.thread ??= b.conversation_id;
    if (e.event === "result")
      f.result = {
        status: String(b.status ?? ""),
        response: typeof b.response === "string" ? b.response : "",
        error: typeof b.error === "string" ? b.error : "",
        tokens: agyTokens(b.usage),
      };
  }
  return f;
}

import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

/** Spec §6.3: these error types are a usage limit, so the rung fails over. */
export const OPENCODE_LIMIT_TYPES = ["provider.quota", "provider.rate-limit"];
export const OPENCODE_LIMIT = [/provider\.quota/, /provider\.rate-limit/];
/** opencode v1 errors: v2's `-m provider/model#variant` is a model v1 cannot find. */
export const OPENCODE_TOO_OLD = [/ProviderModelNotFoundError/];

export interface OpencodeFold {
  thread: string | null;
  tokens: Tokens;
  costUsd: number;
  lastEvent: string | null;
  error: { type: string | null; message: string } | null;
  limit: boolean;
  tooOld: boolean;
  /** the tool call a permission rule declined, e.g. `read <scratch>/outside.txt` */
  declined: string | null;
  /** the text of the last assistant message: earlier narration is not the reply */
  reply: string;
}

type Event = Record<string, any>;

export function parseOpencodeLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) ? (e as Event) : null;
  } catch {
    return null;
  }
}

/** opencode counts cache reads and writes apart from input; catherd's input includes them (spec §4.3). */
export function opencodeTokens(t: Event | undefined): Tokens {
  if (!t) return { ...ZERO_TOKENS };
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const cached = n(t.cache?.read);
  return {
    input: n(t.input) + cached + n(t.cache?.write),
    cached,
    output: n(t.output) + n(t.reasoning),
  };
}

export const eventName = (e: Event): string =>
  e.type === "tool_use" ? `tool_use/${e.part?.tool ?? "?"}` : String(e.type ?? "?");

/** v1 errors are `{name, data}`; v2 errors are `{type, message}`. */
export const isV1Error = (e: Event): boolean =>
  e.type === "error" && typeof e.error?.name === "string" && e.error?.type === undefined;

function firstString(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const v = Object.values(input as Record<string, unknown>).find((x) => typeof x === "string");
  return typeof v === "string" ? v : "";
}

/**
 * v2 often drops the last `step_finish`, so these stream tokens undercount; `settle` replaces them with
 * the session's totals from the API.
 */
export function foldOpencodeEvents(lines: string[]): OpencodeFold {
  const f: OpencodeFold = {
    thread: null,
    tokens: { ...ZERO_TOKENS },
    costUsd: 0,
    lastEvent: null,
    error: null,
    limit: false,
    tooOld: false,
    declined: null,
    reply: "",
  };
  const texts = new Map<string, string[]>();
  let lastMessage: string | null = null;
  for (const line of lines) {
    const e = parseOpencodeLine(line);
    if (!e) continue;
    f.lastEvent = eventName(e);
    if (typeof e.sessionID === "string") f.thread ??= e.sessionID;
    if (e.type === "text" && typeof e.part?.text === "string") {
      const id = String(e.part.messageID ?? "");
      texts.set(id, [...(texts.get(id) ?? []), e.part.text]);
      lastMessage = id;
    } else if (e.type === "step_finish") {
      const t = opencodeTokens(e.part?.tokens);
      f.tokens.input += t.input;
      f.tokens.cached += t.cached;
      f.tokens.output += t.output;
      if (typeof e.part?.cost === "number") f.costUsd += e.part.cost;
    } else if (e.type === "tool_use" && e.part?.state?.status === "error") {
      if (/declined/i.test(String(e.part.state.error ?? "")))
        f.declined = `${e.part.tool} ${firstString(e.part.state.input)}`.trim();
    } else if (e.type === "error") {
      if (isV1Error(e)) {
        f.tooOld = true;
        f.error = { type: null, message: String(e.error.data?.message ?? e.error.name) };
      } else {
        const type = typeof e.error?.type === "string" ? e.error.type : null;
        f.error = { type, message: String(e.error?.message ?? type ?? "error") };
        if (type && OPENCODE_LIMIT_TYPES.includes(type)) f.limit = true;
      }
    }
  }
  if (lastMessage !== null) f.reply = (texts.get(lastMessage) ?? []).join("\n");
  return f;
}

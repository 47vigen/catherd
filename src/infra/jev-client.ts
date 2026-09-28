// Spec §5.5 transport: a thin client (the official SDK is 0.x and Node-targeted) with the SDK's retry
// semantics (research 2026-09-25-jev.md §4, §5.6). The public sources of spec 1.2 §3.3 reuse its policy
// through `retryingFetch`.

export const JEV_BASE = "https://api.typesafe.ai/v1";

export interface JevTransport {
  fetchImpl?: typeof fetch;
  /** the clock and the wait between attempts; tests replace both */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** per attempt (10 s) */
  attemptMs?: number;
  /** for the whole call, retries included (25 s) */
  deadlineMs?: number;
  retries?: number;
}

export type JevResponse =
  | { ok: true; body: unknown; requestId: string | null; latencyMs: number; attempts: number }
  | { ok: false; error: string; status: number | null; latencyMs: number; attempts: number };

/** What `retryingFetch` got: the body's bytes on a 2xx, else the last error and status. */
export type FetchOutcome =
  | { ok: true; status: number; headers: Headers; bytes: Uint8Array; latencyMs: number; attempts: number }
  | {
      ok: false;
      error: string;
      status: number | null;
      /** the last answer's headers, when there was an answer */
      headers: Headers | null;
      latencyMs: number;
      attempts: number;
    };

const RETRY_AFTER_MAX_MS = 10_000;
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/** A header's value, or null when it is absent or blank. */
const header = (h: Headers, name: string): string | null => {
  const v = h.get(name)?.trim();
  return v ? v : null;
};

/** `Retry-After` (seconds or an HTTP date) or `retry-after-ms`, capped at 10 s; null when absent. */
export function retryAfterMs(h: Headers, now: number): number | null {
  const rawMs = header(h, "retry-after-ms");
  const ms = Number(rawMs);
  if (rawMs !== null && Number.isFinite(ms)) return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
  const v = header(h, "retry-after");
  if (v === null) return null;
  const secs = Number(v);
  const wait = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - now;
  return Number.isFinite(wait) ? Math.min(Math.max(wait, 0), RETRY_AFTER_MAX_MS) : null;
}

/** 500 ms doubling per retry, ±25 % jitter. */
const backoffMs = (retry: number, random: () => number) => 500 * 2 ** (retry - 1) * (0.75 + random() * 0.5);

/**
 * A failed status as an error, naming a validation error by Jev's own `error_type` and `message` only,
 * never the raw body (which could echo the request's state).
 */
function httpError(status: number, text: string): string {
  let detail: unknown = null;
  try {
    detail = (JSON.parse(text) as { detail?: unknown })?.detail;
  } catch {
    // not JSON: nothing to name
  }
  if (detail && typeof detail === "object") {
    const { error_type: type, message } = detail as { error_type?: unknown; message?: unknown };
    if (typeof type === "string" && /validation/i.test(type))
      return `http ${status}: ${type}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`;
  }
  return `http ${status}`;
}

/**
 * `url` with the Jev client's retry policy: `attemptMs` per attempt (10 s), up to `retries` (two) retries on
 * 408, 429, 5xx, a network error or a timeout, honouring Retry-After, and never past `deadlineMs` (25 s). The
 * attempt timer covers the whole exchange, body included, and aborts the request when it fires. `headers`
 * builds each attempt's headers from its number (1 first); `errorOf` names a failed status (`http <status>`).
 * Bun's fetch honours HTTPS_PROXY and HTTP_PROXY.
 */
export async function retryingFetch(
  url: string,
  init: { method: "GET" | "POST"; headers: (attempt: number) => Record<string, string>; body?: string },
  o: JevTransport & { errorOf?: (status: number, text: string) => string } = {},
): Promise<FetchOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = o.random ?? Math.random;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const errorOf = o.errorOf ?? ((status: number) => `http ${status}`);
  const start = now();
  const deadline = start + (o.deadlineMs ?? 25_000);
  const retries = o.retries ?? 2;
  let last: { error: string; status: number | null; headers: Headers | null } = {
    error: "network error",
    status: null,
    headers: null,
  };
  let attempt = 0;
  for (;;) {
    attempt++;
    const left = deadline - now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => {
          // settle first, so the race reads a timeout rather than the abort it causes
          resolve("timeout");
          ctl.abort();
        },
        Math.min(o.attemptMs ?? 10_000, Math.max(left, 0)),
      );
    });
    const exchange = async () => {
      const res = await fetchImpl(url, {
        method: init.method,
        headers: init.headers(attempt),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: ctl.signal,
      });
      if (res.ok) return { res, bytes: new Uint8Array(await res.arrayBuffer()), text: "" };
      return { res, bytes: new Uint8Array(), text: await res.text().catch(() => "") };
    };
    let wait: number | null = null;
    try {
      const r = await Promise.race([exchange(), timeout]);
      if (r === "timeout") {
        last = { error: "timeout", status: null, headers: null };
      } else if (r.res.ok) {
        return {
          ok: true,
          status: r.res.status,
          headers: r.res.headers,
          bytes: r.bytes,
          latencyMs: now() - start,
          attempts: attempt,
        };
      } else {
        last = { error: errorOf(r.res.status, r.text), status: r.res.status, headers: r.res.headers };
        if (!retryable(r.res.status))
          return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
        wait = retryAfterMs(r.res.headers, now());
      }
    } catch {
      last = { error: "network error", status: null, headers: null };
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    if (attempt > retries) break;
    const pause = wait ?? backoffMs(attempt, random);
    if (now() + pause >= deadline) {
      last = { ...last, error: `deadline (${last.error})` };
      break;
    }
    await sleep(pause);
  }
  return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
}

/** `method path` against the Jev API with a bearer key, under `retryingFetch`'s policy. */
export async function jevRequest(
  method: "GET" | "POST",
  path: string,
  key: string,
  body: unknown,
  o: JevTransport = {},
): Promise<JevResponse> {
  const r = await retryingFetch(
    `${JEV_BASE}${path}`,
    {
      method,
      headers: (attempt) => ({
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { ...o, errorOf: httpError },
  );
  if (!r.ok)
    return { ok: false, error: r.error, status: r.status, latencyMs: r.latencyMs, attempts: r.attempts };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(r.bytes));
  } catch {
    return {
      ok: false,
      error: "unexpected response",
      status: r.status,
      latencyMs: r.latencyMs,
      attempts: r.attempts,
    };
  }
  return {
    ok: true,
    body: parsed,
    requestId: r.headers.get("x-typesafe-request-id"),
    latencyMs: r.latencyMs,
    attempts: r.attempts,
  };
}

// Spec §5.5 transport: a thin client (the official SDK is 0.x and Node-targeted) with the SDK's retry
// semantics (research 2026-09-25-jev.md §4, §5.6).

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
 * `method path` against the Jev API with a bearer key: 10 s per attempt, up to two retries on 408, 429,
 * 5xx, a network error or a timeout, honouring Retry-After, and never past the 25 s deadline. The attempt
 * timer covers the whole exchange, body included, and aborts the request when it fires.
 */
export async function jevRequest(
  method: "GET" | "POST",
  path: string,
  key: string,
  body: unknown,
  o: JevTransport = {},
): Promise<JevResponse> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = o.random ?? Math.random;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const start = now();
  const deadline = start + (o.deadlineMs ?? 25_000);
  const retries = o.retries ?? 2;
  let last: { error: string; status: number | null } = { error: "network error", status: null };
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
      const res = await fetchImpl(`${JEV_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctl.signal,
      });
      const text = res.ok ? await res.text() : await res.text().catch(() => "");
      return { res, text };
    };
    let wait: number | null = null;
    try {
      const r = await Promise.race([exchange(), timeout]);
      if (r === "timeout") {
        last = { error: "timeout", status: null };
      } else if (r.res.ok) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(r.text);
        } catch {
          return {
            ok: false,
            error: "unexpected response",
            status: r.res.status,
            latencyMs: now() - start,
            attempts: attempt,
          };
        }
        return {
          ok: true,
          body: parsed,
          requestId: r.res.headers.get("x-typesafe-request-id"),
          latencyMs: now() - start,
          attempts: attempt,
        };
      } else {
        last = { error: httpError(r.res.status, r.text), status: r.res.status };
        if (!retryable(r.res.status))
          return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
        wait = retryAfterMs(r.res.headers, now());
      }
    } catch {
      last = { error: "network error", status: null };
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
    if (attempt > retries) break;
    const pause = wait ?? backoffMs(attempt, random);
    if (now() + pause >= deadline) {
      last = { error: `deadline (${last.error})`, status: last.status };
      break;
    }
    await sleep(pause);
  }
  return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
}

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

/** `Retry-After` (seconds or an HTTP date) or `retry-after-ms`, capped at 10 s; null when absent. */
export function retryAfterMs(h: Headers, now: number): number | null {
  const ms = Number(h.get("retry-after-ms"));
  if (h.get("retry-after-ms") !== null && Number.isFinite(ms))
    return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
  const v = h.get("retry-after");
  if (v === null) return null;
  const secs = Number(v);
  const wait = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - now;
  return Number.isFinite(wait) ? Math.min(Math.max(wait, 0), RETRY_AFTER_MAX_MS) : null;
}

/** 500 ms doubling per retry, ±25 % jitter. */
const backoffMs = (retry: number, random: () => number) => 500 * 2 ** (retry - 1) * (0.75 + random() * 0.5);

/**
 * `method path` against the Jev API with a bearer key: 10 s per attempt, up to two retries on 408, 429,
 * 5xx, a network error or a timeout, honouring Retry-After, and never past the 25 s deadline.
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
      timer = setTimeout(() => resolve("timeout"), Math.min(o.attemptMs ?? 10_000, Math.max(left, 0)));
    });
    let wait: number | null = null;
    try {
      const res = await Promise.race([
        fetchImpl(`${JEV_BASE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ctl.signal,
        }),
        timeout,
      ]);
      if (res === "timeout") {
        ctl.abort();
        last = { error: "timeout", status: null };
      } else if (res.ok) {
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          return {
            ok: false,
            error: "unexpected response",
            status: res.status,
            latencyMs: now() - start,
            attempts: attempt,
          };
        }
        return {
          ok: true,
          body: parsed,
          requestId: res.headers.get("x-typesafe-request-id"),
          latencyMs: now() - start,
          attempts: attempt,
        };
      } else {
        const detail = await res.text().catch(() => "");
        last = {
          error: `http ${res.status}${/validation/i.test(detail) ? `: ${detail.slice(0, 200)}` : ""}`,
          status: res.status,
        };
        if (!retryable(res.status))
          return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
        wait = retryAfterMs(res.headers, now());
      }
    } catch {
      last = { error: "network error", status: null };
    } finally {
      clearTimeout(timer);
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

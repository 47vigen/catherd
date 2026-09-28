import { type JevTransport, retryingFetch } from "../jev-client.ts";
import { VERSION } from "../version.ts";

/** How a source is fetched; tests replace `fetchImpl` and the clock, so no test reaches the network. */
export type SourceTransport = JevTransport;

/** A source request that failed: the error, and the status and headers of the last answer when there was one. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly headers: Headers | null = null,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface SourceResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text(): string;
  /** the body as JSON; a SourceError when it is not */
  json(): unknown;
}

/** Spec 1.2 §3.3: one timeout per source; the big files (models.dev, LiteLLM, Epoch) need more than Jev's 10 s. */
const ATTEMPT_MS = 30_000;
const DEADLINE_MS = 60_000;

/**
 * Spec 1.2 §3.3: GET `url` with the Jev client's retry policy and the source's own timeout (30 s an attempt,
 * 60 s in all, unless the transport says otherwise). Throws a SourceError on any failure.
 */
export async function sourceGet(
  url: string,
  o: SourceTransport & { headers?: Record<string, string> } = {},
): Promise<SourceResponse> {
  const { headers = {}, ...t } = o;
  const r = await retryingFetch(
    url,
    {
      method: "GET",
      headers: () => ({
        "user-agent": `catherd-cli/${VERSION} (+https://github.com/47vigen/catherd)`,
        ...headers,
      }),
    },
    { attemptMs: ATTEMPT_MS, deadlineMs: DEADLINE_MS, ...t },
  );
  if (!r.ok) throw new SourceError(r.error, r.status, r.headers);
  const { bytes, status } = r;
  const text = () => new TextDecoder().decode(bytes);
  return {
    status,
    headers: r.headers,
    bytes,
    text,
    json() {
      try {
        return JSON.parse(text());
      } catch {
        throw new SourceError("unexpected response (not JSON)", status, r.headers);
      }
    },
  };
}

/** `x-ratelimit-remaining` of an answer, when it has one (Artificial Analysis, spec 1.2 §9). */
export function rateLimitRemaining(h: Headers | null): number | null {
  const raw = h?.get("x-ratelimit-remaining")?.trim();
  const v = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(v) ? v : null;
}

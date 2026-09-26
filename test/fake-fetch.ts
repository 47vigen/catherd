export interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * A scripted reply; "hang" never answers until the request is aborted, and "stall" sends a 200's headers
 * and the start of a body that never ends until the request is aborted.
 */
export type Reply =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | Error
  | "hang"
  | "stall";

/** A fetch that answers from a script: replies are served in order and the last one repeats. */
export function fakeFetch(...replies: Reply[]): { impl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (!r) throw new Error("fakeFetch: no reply scripted");
    if (r instanceof Error) throw r;
    if (r === "hang")
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    if (r === "stall") {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"model":'));
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  };
  return { impl: impl as typeof fetch, sent };
}

export interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

export type Reply = { status: number; body: unknown } | Error;

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
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl: impl as typeof fetch, sent };
}

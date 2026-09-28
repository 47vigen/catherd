import { describe, expect, it } from "bun:test";
import { rateLimitRemaining, SourceError, sourceGet } from "../../../src/infra/sources/http.ts";
import { VERSION } from "../../../src/infra/version.ts";
import { fakeFetch } from "../../fake-fetch.ts";

/** A fake clock: sleeping advances it, so retries never wait for real. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
}

describe("sourceGet (spec 1.2 §3.3)", () => {
  it("gets a source with catherd's user agent and any header it needs, and reads its JSON", async () => {
    const f = fakeFetch({ status: 200, body: { data: [1] } });
    const r = await sourceGet("https://example.com/a.json", {
      fetchImpl: f.impl,
      headers: { "x-api-key": "k" },
      ...clock(),
    });
    expect(r.json()).toEqual({ data: [1] });
    expect(f.sent[0]?.headers.get("user-agent")).toBe(
      `catherd-cli/${VERSION} (+https://github.com/47vigen/catherd)`,
    );
    expect(f.sent[0]?.headers.get("x-api-key")).toBe("k");
  });

  it("retries a 503 as the Jev client does, then gives up with the status and headers", async () => {
    const f = fakeFetch({ status: 503, body: {}, headers: { "x-ratelimit-remaining": "7" } });
    const e = await sourceGet("https://example.com/a.json", { fetchImpl: f.impl, ...clock() }).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(SourceError);
    expect([e.message, e.status, f.sent.length]).toEqual(["http 503", 503, 3]);
    expect(rateLimitRemaining(e.headers)).toBe(7);
  });

  it("never retries a 403 or 404, and names a body that is not JSON", async () => {
    const f = fakeFetch({ status: 404, body: {} });
    const e = await sourceGet("https://example.com/a.json", { fetchImpl: f.impl, ...clock() }).catch(
      (x) => x,
    );
    expect([e.message, f.sent.length]).toEqual(["http 404", 1]);
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const r = await sourceGet("https://example.com/a", { fetchImpl: html, ...clock() });
    expect(r.text()).toBe("<html>");
    expect(() => r.json()).toThrow("unexpected response (not JSON)");
  });

  it("times out a source that never answers", async () => {
    const f = fakeFetch("hang");
    const e = await sourceGet("https://example.com/a.json", {
      fetchImpl: f.impl,
      ...clock(),
      attemptMs: 10,
      retries: 0,
    }).catch((x) => x);
    expect(e.message).toBe("timeout");
  });

  it("reads x-ratelimit-remaining only when the answer has a number there", () => {
    expect(rateLimitRemaining(new Headers({ "x-ratelimit-remaining": "98" }))).toBe(98);
    expect(rateLimitRemaining(new Headers({ "x-ratelimit-remaining": " " }))).toBeNull();
    expect(rateLimitRemaining(new Headers())).toBeNull();
    expect(rateLimitRemaining(null)).toBeNull();
  });
});

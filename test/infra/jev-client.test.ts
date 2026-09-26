import { describe, expect, it } from "bun:test";
import { JEV_BASE, jevRequest, retryAfterMs } from "../../src/infra/jev-client.ts";
import { fakeFetch } from "../fake-fetch.ts";

/** A fake clock: sleeping advances it, so retries never wait for real. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    random: () => 0.5,
  };
}

const ok = {
  status: 200,
  body: { model: "jev-1.13.0", answers: {} },
  headers: { "x-typesafe-request-id": "req_1" },
};

describe("jevRequest", () => {
  it("posts with the bearer key and returns the body with the request id", async () => {
    const f = fakeFetch(ok);
    const r = await jevRequest("POST", "/systemone", "k", { a: 1 }, { fetchImpl: f.impl, ...clock() });
    expect(r).toMatchObject({ ok: true, requestId: "req_1", attempts: 1 });
    expect(f.sent[0]?.url).toBe(`${JEV_BASE}/systemone`);
    expect(f.sent[0]?.headers.get("authorization")).toBe("Bearer k");
    expect(f.sent[0]?.body).toEqual({ a: 1 });
  });

  it("retries 408, 429 and 5xx twice with doubling backoff, counting retries in a header", async () => {
    const c = clock();
    const f = fakeFetch({ status: 529, body: {} }, { status: 408, body: {} }, ok);
    const r = await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...c });
    expect(r.ok && r.attempts).toBe(3);
    expect(c.waits).toEqual([500, 1000]);
    expect(f.sent[2]?.headers.get("x-typesafe-retry-count")).toBe("2");
  });

  it("honours Retry-After up to 10 s", async () => {
    const c = clock();
    const f = fakeFetch({ status: 429, body: {}, headers: { "retry-after": "3" } }, ok);
    expect((await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...c })).ok).toBe(true);
    expect(c.waits).toEqual([3000]);
    expect(retryAfterMs(new Headers({ "retry-after": "120" }), 0)).toBe(10_000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250" }), 0)).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after": new Date(5_000).toUTCString() }), 3_000)).toBe(2_000);
    expect(retryAfterMs(new Headers(), 0)).toBeNull();
  });

  it("never retries 400, 401, 403, 404 or 422, and names a validation error", async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = fakeFetch({ status, body: {} });
      expect(
        await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...clock() }),
      ).toMatchObject({
        ok: false,
        error: `http ${status}`,
        attempts: 1,
      });
    }
    const v = fakeFetch({
      status: 422,
      body: { detail: { error_type: "validation_error", message: "bad" } },
    });
    const r = await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: v.impl, ...clock() });
    expect(r).toMatchObject({ ok: false, error: "http 422: validation_error: bad", attempts: 1 });
  });

  it("gives up after two retries, and stops early rather than sleep past the deadline", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    expect(await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...clock() })).toMatchObject({
      ok: false,
      error: "network error",
      attempts: 3,
    });
    const slow = fakeFetch({ status: 503, body: {}, headers: { "retry-after": "8" } });
    const c = clock();
    const r = await jevRequest(
      "POST",
      "/systemone",
      "k",
      {},
      { fetchImpl: slow.impl, ...c, deadlineMs: 12_000 },
    );
    expect(r).toMatchObject({ ok: false, error: "deadline (http 503)", attempts: 2 });
    expect(c.waits).toEqual([8000]);
  });

  it("times out a hung attempt and retries it", async () => {
    const f = fakeFetch("hang", ok);
    const r = await jevRequest(
      "POST",
      "/systemone",
      "k",
      {},
      { fetchImpl: f.impl, ...clock(), attemptMs: 20 },
    );
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("times out a body that stalls after the headers, aborting the request, and retries it", async () => {
    const f = fakeFetch("stall", ok);
    const r = await jevRequest(
      "POST",
      "/systemone",
      "k",
      {},
      { fetchImpl: f.impl, ...clock(), attemptMs: 20 },
    );
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("returns by the deadline when every body stalls", async () => {
    const f = fakeFetch("stall");
    const r = await jevRequest(
      "POST",
      "/systemone",
      "k",
      {},
      { fetchImpl: f.impl, ...clock(), deadlineMs: 20 },
    );
    expect(r).toMatchObject({ ok: false, error: "deadline (timeout)", status: null, attempts: 1 });
  });

  it("falls back to backoff on a blank Retry-After, and sends no content type without a body", async () => {
    expect(retryAfterMs(new Headers({ "retry-after": " " }), 0)).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after-ms": "" }), 0)).toBeNull();
    const f = fakeFetch(ok);
    await jevRequest("GET", "/models", "k", undefined, { fetchImpl: f.impl, ...clock() });
    expect(f.sent[0]?.headers.get("content-type")).toBeNull();
  });

  it("reports a 200 that is not JSON", async () => {
    const f = fakeFetch({ status: 200, body: "x" });
    const bad = { impl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch };
    expect((await jevRequest("GET", "/models", "k", undefined, { fetchImpl: bad.impl, ...clock() })).ok).toBe(
      false,
    );
    expect((await jevRequest("GET", "/models", "k", undefined, { fetchImpl: f.impl, ...clock() })).ok).toBe(
      true,
    );
  });
});

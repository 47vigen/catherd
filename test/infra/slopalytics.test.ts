import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchProxy, readIndexFile, SLOPALYTICS_URL, writeIndexFile } from "../../src/infra/slopalytics.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { tempDir } from "../helpers.ts";

const proxyFixture = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "slopalytics-proxy.json"), "utf8"),
);

describe("fetchProxy", () => {
  it("fetches the proxy and parses it", async () => {
    const { impl, sent } = fakeFetch({ status: 200, body: proxyFixture });
    const r = await fetchProxy({ fetch: impl });
    expect(sent.map((s) => [s.method, s.url])).toEqual([["GET", SLOPALYTICS_URL]]);
    expect(r.models).toHaveLength(3);
  });

  it("throws on an http error and on an answer with no indexed pair", async () => {
    await expect(fetchProxy({ fetch: fakeFetch({ status: 503, body: {} }).impl })).rejects.toThrow(
      "http 503",
    );
    await expect(
      fetchProxy({ fetch: fakeFetch({ status: 200, body: { models: [] } }).impl }),
    ).rejects.toThrow("no indexed pairs");
  });

  it("gives up on a proxy that never answers", async () => {
    await expect(fetchProxy({ fetch: fakeFetch("hang").impl, timeoutMs: 20 })).rejects.toThrow();
  });
});

describe("the index file", () => {
  it("reads a missing or unreadable index file as none, and round-trips a written one", () => {
    const file = join(tempDir("catherd-idx-"), "slopalytics.json");
    expect(readIndexFile(file)).toBeNull();
    Bun.write(file, "{");
    expect(readIndexFile(file)).toBeNull();
    const f = {
      schema: 1 as const,
      checkedAt: "2026-10-21T00:00:00.000Z",
      fetchedAt: null,
      error: null,
      models: [],
    };
    writeIndexFile(file, f);
    expect(readIndexFile(file)).toEqual(f);
  });
});

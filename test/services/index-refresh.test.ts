import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readIndexFile } from "../../src/infra/slopalytics.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { indexStatus, INDEX_TTL_MS, refreshIndex } from "../../src/services/catalog-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const proxy = {
  status: 200,
  body: JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "slopalytics-proxy.json"), "utf8")),
};
const checkedAt = () => Date.parse(readIndexFile(indexPath())?.checkedAt as string);

describe("refreshIndex", () => {
  it("fetches when the index is an hour old, and not before", async () => {
    withHome();
    const f = fakeFetch(proxy);
    const at = checkedAt();
    await refreshIndex({ fetch: f.impl, now: at + INDEX_TTL_MS - 60_000 });
    expect(f.sent).toHaveLength(0);
    const s = await refreshIndex({ fetch: f.impl, now: at + INDEX_TTL_MS + 60_000 });
    expect(f.sent).toHaveLength(1);
    expect(s).toMatchObject({ pairs: 3, error: null });
    expect(checkedAt()).toBe(at + INDEX_TTL_MS + 60_000);
  });

  it("keeps the last good index and records the error when the proxy fails", async () => {
    withHome();
    const before = readIndexFile(indexPath());
    const s = await refreshIndex({ force: true, fetch: fakeFetch({ status: 503, body: {} }).impl });
    const after = readIndexFile(indexPath());
    expect(after?.models).toEqual(before?.models as never);
    expect(after?.fetchedAt).toBe(before?.fetchedAt as string);
    expect(after?.error?.message).toBe("http 503");
    expect(s.error).toBe("http 503");
    expect(s.pairs).toBe(before?.models.length as number);
  });

  it("records the error, with no index, when the first fetch fails", async () => {
    withHome();
    rmSync(indexPath());
    expect(indexStatus()).toEqual({ fetchedAt: null, checkedAt: null, pairs: 0, error: null });
    const s = await refreshIndex({ fetch: fakeFetch(new Error("offline")).impl });
    expect(s).toMatchObject({ pairs: 0, fetchedAt: null, error: "offline" });
  });

  it("fetches nothing on an automatic refresh under CATHERD_NO_SYNC=1, and does on an explicit one", async () => {
    withHome();
    rmSync(indexPath());
    process.env.CATHERD_NO_SYNC = "1";
    const f = fakeFetch(proxy);
    await refreshIndex({ auto: true, fetch: f.impl });
    expect(f.sent).toHaveLength(0);
    const s = await refreshIndex({ fetch: f.impl });
    expect(f.sent).toHaveLength(1);
    expect(s.pairs).toBe(3);
  });

  it("creates the data directory for the lock on a first fetch", async () => {
    withHome();
    rmSync(dirname(indexPath()), { recursive: true });
    const s = await refreshIndex({ fetch: fakeFetch(proxy).impl });
    expect(s.pairs).toBe(3);
  });

  it("fetches inside the hour when forced", async () => {
    withHome();
    const f = fakeFetch(proxy);
    await refreshIndex({ force: true, fetch: f.impl, now: checkedAt() + 1000 });
    expect(f.sent).toHaveLength(1);
  });

  for (const order of ["success first", "failure first"] as const) {
    it(`keeps the newer good index when a slow refresh fails after another succeeds (${order})`, async () => {
      withHome();
      const ok = fakeFetch(proxy).impl;
      const slow = (async () => {
        await Bun.sleep(30);
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const now = checkedAt() + 1000;
      const runs = order === "success first" ? [ok, slow] : [slow, ok];
      await Promise.all(runs.map((fetch) => refreshIndex({ force: true, fetch, now })));
      expect(readIndexFile(indexPath())?.models).toHaveLength(3);
    });
  }
});

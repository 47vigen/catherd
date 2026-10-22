import { beforeEach, describe, expect, it } from "bun:test";
import type { BackendAdapter, Probe } from "../../src/adapters/backend.ts";
import { cachedProbe, PROBE_TTL_MS, probeCache } from "../../src/services/probe-cache.ts";

const ready: Probe = { installed: true, version: "1.0.0", versionOk: true, loggedIn: true, problems: [] };

/** A fake adapter whose probe counts, and resolves with the next `results` entry when the test says. */
function fake(results: (() => Promise<Probe>)[] = []) {
  let calls = 0;
  const adapter = {
    id: "codex",
    probe: () => results[calls++]?.() ?? Promise.resolve(ready),
  } as unknown as BackendAdapter;
  return { adapter, calls: () => calls };
}

let clock = 1_000_000;
beforeEach(() => {
  probeCache.clear();
  clock = 1_000_000;
  probeCache.now = () => clock;
});

describe("the probe cache", () => {
  it("serves a fresh probe from the cache", async () => {
    const f = fake();
    const a = await cachedProbe(f.adapter);
    clock += PROBE_TTL_MS - 1;
    const b = await cachedProbe(f.adapter);
    expect([f.calls(), b]).toEqual([1, a]);
    expect(a.probedAt).toBe(new Date(1_000_000).toISOString());
  });

  it("serves a stale probe at once and refreshes it once behind it", async () => {
    let release: (p: Probe) => void = () => {};
    const f = fake([() => Promise.resolve(ready), () => new Promise<Probe>((r) => (release = r))]);
    await cachedProbe(f.adapter);
    clock += PROBE_TTL_MS + 1;
    const stale = await cachedProbe(f.adapter);
    const again = await cachedProbe(f.adapter); // shares the refresh already running
    expect([stale.version, again.version, f.calls()]).toEqual(["1.0.0", "1.0.0", 2]);
    release({ ...ready, version: "2.0.0" });
    await cachedProbe(f.adapter, { force: true }); // joins the refresh, so it settles after it
    const fresh = await cachedProbe(f.adapter);
    expect([fresh.version, fresh.probedAt, f.calls()]).toEqual(["2.0.0", new Date(clock).toISOString(), 2]);
  });

  it("probes again when forced", async () => {
    const f = fake();
    await cachedProbe(f.adapter);
    await cachedProbe(f.adapter, { force: true });
    expect(f.calls()).toBe(2);
  });

  it("caches a failing probe too", async () => {
    const f = fake([() => Promise.reject(new Error("boom"))]);
    const a = await cachedProbe(f.adapter);
    const b = await cachedProbe(f.adapter);
    expect([f.calls(), a.installed, a.problems[0]?.message, b]).toEqual([1, false, "boom", a]);
  });
});

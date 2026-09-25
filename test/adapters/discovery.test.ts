import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import type { DiscoveredModel } from "../../src/adapters/backend.ts";
import { discovered, discoveryPath, readDiscovery, writeDiscovery } from "../../src/adapters/discovery.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const M = (id: string): DiscoveredModel => ({ id, efforts: ["high"], context: null, imageIn: false });
const T0 = Date.parse("2026-09-25T10:00:00.000Z");
const HOUR = 3_600_000;

describe("discovery cache", () => {
  it("writes <data>/discovery/<backend>.json with a schema and fetchedAt, and reads it back", () => {
    withHome();
    writeDiscovery("opencode", [M("opencode/a")], T0);
    expect(readDiscovery("opencode")).toEqual({
      schema: 1,
      backend: "opencode",
      fetchedAt: "2026-09-25T10:00:00.000Z",
      models: [M("opencode/a")],
    });
  });

  it("reads a missing or corrupt cache as none", () => {
    withHome();
    expect(readDiscovery("opencode")).toBeNull();
    writeDiscovery("opencode", [], T0);
    writeFileSync(discoveryPath("opencode"), "{not json");
    expect(readDiscovery("opencode")).toBeNull();
  });

  it("lists again when the cache is stale or lacks the model asked for, and keeps it otherwise", async () => {
    withHome();
    let calls = 0;
    const list = async () => {
      calls++;
      return [M("opencode/a"), M("opencode/b")];
    };
    writeDiscovery("opencode", [M("opencode/a")], T0);
    expect(await discovered("opencode", list, { maxAgeMs: 24 * HOUR, now: T0 + HOUR })).toHaveLength(1);
    expect(calls).toBe(0);
    expect(
      await discovered("opencode", list, { maxAgeMs: 24 * HOUR, need: "opencode/b", now: T0 + HOUR }),
    ).toHaveLength(2);
    expect(calls).toBe(1);
    await discovered("opencode", list, { maxAgeMs: 24 * HOUR, now: T0 + 30 * HOUR });
    expect(calls).toBe(2);
  });

  it("keeps the old cache when a fresh listing comes back empty", async () => {
    withHome();
    writeDiscovery("opencode", [M("opencode/a")], T0);
    const got = await discovered("opencode", async () => [], { maxAgeMs: HOUR, now: T0 + 2 * HOUR });
    expect(got).toEqual([M("opencode/a")]);
    expect(readDiscovery("opencode")?.fetchedAt).toBe("2026-09-25T10:00:00.000Z");
  });
});

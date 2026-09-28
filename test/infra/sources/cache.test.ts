import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sourcesDir } from "../../../src/infra/paths.ts";
import {
  cachePath,
  readCached,
  readSyncState,
  tryLockSync,
  writeCached,
  writeSyncState,
} from "../../../src/infra/sources/cache.ts";
import { noPosixModes, snapshotEnv, withHome } from "../../helpers.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-09-28T10:00:00.000Z");

describe("the source cache (spec 1.2 §3.3)", () => {
  it("keeps each source's answer with its fetch time in <data>/sources/<source>.json", () => {
    withHome();
    expect(readCached("vectara")).toBeNull();
    writeCached("vectara", "| table |", T0, { note: 1 });
    expect(cachePath("vectara")).toBe(`${sourcesDir()}/vectara.json`);
    expect(readCached("vectara")).toEqual({
      schema: 1,
      source: "vectara",
      fetchedAt: "2026-09-28T10:00:00.000Z",
      data: "| table |",
      meta: { note: 1 },
    });
  });

  it.skipIf(noPosixModes)("writes it at mode 600", () => {
    withHome();
    writeCached("arena", {}, T0);
    expect(statSync(cachePath("arena")).mode & 0o777).toBe(0o600);
  });

  it("reads an unreadable cache file as none, so the next sync writes it again", () => {
    withHome();
    mkdirSync(dirname(cachePath("epoch")), { recursive: true });
    writeFileSync(cachePath("epoch"), "{not json");
    expect(readCached("epoch")).toBeNull();
  });

  it("keeps each source's last attempt and error in state.json, empty before the first sync", () => {
    withHome();
    expect(readSyncState()).toEqual({ schema: 1, sources: {} });
    writeSyncState({
      schema: 1,
      sources: {
        arena: { lastAttemptAt: "2026-09-28T10:00:00.000Z", error: "http 503", rateLimitRemaining: null },
      },
    });
    expect(readSyncState().sources.arena?.error).toBe("http 503");
  });

  it("lets one sync hold the lock at a time", () => {
    withHome();
    const release = tryLockSync();
    expect(release).not.toBeNull();
    expect(tryLockSync()).toBeNull();
    release?.();
    const again = tryLockSync();
    expect(again).not.toBeNull();
    again?.();
  });
});

import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel, tryClaim } from "../../src/infra/dispatch-dir.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";

const d = () => mkdtempSync(join(tmpdir(), "catherd-dispatch-"));

describe("dispatch folder", () => {
  it("stores all owner/event attempts in one dispatch delivery file", () => {
    const dir = d();
    expect(dispatchPaths(dir).delivery).toBe(join(dir, "delivery.json"));
  });
  it("lets exactly one finalizer claim a dispatch", () => {
    const dir = d();
    const results = [tryClaim(dir), tryClaim(dir), tryClaim(dir)];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("drops a claim it could not write its name into, so no finalizer waits on it until it is stale", () => {
    const dir = d();
    const write = spyOn(fs, "writeSync").mockImplementation(() => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });
    try {
      expect(() => tryClaim(dir)).toThrow("no space left");
    } finally {
      write.mockRestore();
    }
    expect(existsSync(dispatchPaths(dir).claim)).toBe(false);
    expect(tryClaim(dir)).toBe(true);
  });

  it("reads exit.json, or null when absent or unreadable", () => {
    const dir = d();
    expect(readExit(dir)).toBeNull();
    writeFileSync(dispatchPaths(dir).exit, "{partial");
    expect(readExit(dir)).toBeNull();
    writeJsonAtomic(dispatchPaths(dir).exit, {
      schema: 1,
      code: 0,
      signal: null,
      reason: "exited",
      endedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(readExit(dir)).toEqual({
      code: 0,
      signal: null,
      reason: "exited",
      endedAt: "2026-09-25T00:00:00.000Z",
    });
  });

  it("marks a cancel request with a file the supervisor polls", () => {
    const dir = d();
    requestCancel(dir);
    expect(existsSync(dispatchPaths(dir).cancel)).toBe(true);
  });
});

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel, tryClaim } from "../../src/infra/dispatch-dir.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";

const d = () => mkdtempSync(join(tmpdir(), "catherd-dispatch-"));

describe("dispatch folder", () => {
  it("lets exactly one finalizer claim a dispatch", () => {
    const dir = d();
    const results = [tryClaim(dir), tryClaim(dir), tryClaim(dir)];
    expect(results.filter(Boolean)).toHaveLength(1);
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

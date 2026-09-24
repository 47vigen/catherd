import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { changedSince, parseReplyStatus, snapshotOwned } from "../src/core/reply.ts";
import { tempRepo } from "./helpers.ts";

describe("parseReplyStatus", () => {
  test("reads the STATUS line when it is the last non-empty line", () => {
    expect(parseReplyStatus("did things\nSTATUS: complete — all green\n\n")).toEqual({
      status: "complete",
      why: "all green",
    });
  });

  test("accepts a plain hyphen separator", () => {
    expect(parseReplyStatus("STATUS: refused - out of scope").status).toBe("refused");
  });

  test("returns null when the STATUS line is missing or not last", () => {
    expect(parseReplyStatus("no status here")).toEqual({ status: null, why: null });
    expect(parseReplyStatus("STATUS: complete — x\nmore text after")).toEqual({ status: null, why: null });
  });

  test("returns null for an unknown status word", () => {
    expect(parseReplyStatus("STATUS: finished — x").status).toBeNull();
  });
});

describe("owned-file snapshots", () => {
  test("reports only files this run changed, even when they were dirty before", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.ts"), "dirty before the run");
    writeFileSync(join(repo, "b.ts"), "untouched");
    const before = snapshotOwned(repo, ["a.ts", "b.ts", "c.ts"]);
    writeFileSync(join(repo, "c.ts"), "created by the run");
    expect(changedSince(repo, before, ["a.ts", "b.ts", "c.ts"])).toEqual(["c.ts"]);
  });

  test("walks owned directories and sees deletions", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "src", "jobs"), { recursive: true });
    writeFileSync(join(repo, "src", "jobs", "list.ts"), "1");
    writeFileSync(join(repo, "src", "jobs", "gone.ts"), "1");
    const before = snapshotOwned(repo, ["src/jobs"]);
    rmSync(join(repo, "src", "jobs", "gone.ts"));
    writeFileSync(join(repo, "src", "jobs", "list.ts"), "2");
    expect(changedSince(repo, before, ["src/jobs"]).sort()).toEqual(["src/jobs/gone.ts", "src/jobs/list.ts"]);
  });

  test("treats owned paths literally, even with glob characters", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "app", "[id]"), { recursive: true });
    writeFileSync(join(repo, "app", "[id]", "page.tsx"), "1");
    writeFileSync(join(repo, "app", "i"), "not owned");
    const before = snapshotOwned(repo, ["app/[id]"]);
    writeFileSync(join(repo, "app", "i"), "changed, but not owned");
    writeFileSync(join(repo, "app", "[id]", "page.tsx"), "2");
    expect(changedSince(repo, before, ["app/[id]"])).toEqual(["app/[id]/page.tsx"]);
  });

  test("returns nothing when nothing changed", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.ts"), "x");
    const before = snapshotOwned(repo, ["a.ts"]);
    expect(changedSince(repo, before, ["a.ts"])).toEqual([]);
  });
});

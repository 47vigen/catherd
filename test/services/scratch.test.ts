import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { scratchDir } from "../../src/services/dispatches.ts";
import { createRun, runPaths } from "../../src/services/run-store.ts";
import { cleanScratch } from "../../src/services/scratch.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

describe("catherd runs clean (spec 1.5 plan 21)", () => {
  it("removes a finished run's scratch, keeps a run whose role still writes there, and keeps the run itself", async () => {
    const { run: done } = freshRun("done");
    const live = createRun({ repo: tempRepo(), title: "live", aLines: ["A1"], version: "0.0.0-test" });
    await fakeDispatch(done, { name: "worker-M1.L1" }, { proc: "dead", exit });
    await fakeDispatch(live, { name: "worker-M1.L1" }, { proc: "self" });
    for (const run of [done, live]) {
      mkdirSync(scratchDir(run, "worker-M1.L1"), { recursive: true });
      writeFileSync(join(scratchDir(run, "worker-M1.L1"), "payment"), "x".repeat(2048));
    }
    const r = cleanScratch();
    expect(r.removed).toEqual([{ run: done.id, bytes: 2048 }]);
    expect(r.kept).toEqual([{ run: live.id, why: "worker-M1.L1 still running" }]);
    expect(existsSync(runPaths(done.dir).scratch)).toBe(false);
    expect(existsSync(runPaths(done.dir).meta)).toBe(true);
    expect(existsSync(join(scratchDir(live, "worker-M1.L1"), "payment"))).toBe(true);
    // one run by id; nothing left to remove is not an error
    expect(cleanScratch({ run: done.id })).toEqual({ removed: [], kept: [] });
  });

  it("never removes the scratch of a dispatch being admitted: cleanup waits out the run's admission (PR #46)", () => {
    const { run } = freshRun("admitting");
    // an admission in its critical section: it holds the run's admission lock and has created the role's scratch
    const release = tryLock(runPaths(run.dir).admission);
    expect(release).not.toBeNull();
    try {
      mkdirSync(scratchDir(run, "worker-M1.L1"), { recursive: true });
      const r = cleanScratch();
      expect(r.removed).toEqual([]);
      expect(r.kept).toEqual([{ run: run.id, why: "a dispatch is being admitted" }]);
      expect(existsSync(scratchDir(run, "worker-M1.L1"))).toBe(true);
    } finally {
      release?.();
    }
    // once the admission is over (here, it admitted nothing), the scratch is the run's to clean
    expect(cleanScratch({ run: run.id }).removed.map((x) => x.run)).toEqual([run.id]);
  });
});

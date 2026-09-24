import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { reconcileLive } from "../src/core/reconcile.ts";
import { createRun, readLive, readRunRecords, rolePaths, writeLive } from "../src/core/runstore.ts";
import { tempRepo, withHome } from "./helpers.ts";

describe("reconcileLive", () => {
  beforeEach(() => withHome());

  test("finishes the record of a run whose process is gone, from its files", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    const p = rolePaths(run.dir, "worker-M1.L1");
    copyFileSync(join(import.meta.dir, "fixtures", "codex", "ok-with-reconnect.jsonl"), p.jsonl);
    writeFileSync(p.out, "done\nSTATUS: complete — green");
    const dead = Bun.spawn(["bun", "-e", "0"]);
    await dead.exited;
    writeLive(run.dir, {
      name: "worker-M1.L1",
      role: "worker",
      backend: "codex",
      rung: "gpt-6-sol#medium",
      pid: dead.pid,
      thread: null,
      startedAt: new Date().toISOString(),
      cwd: repo,
      ownedFiles: [],
      isolated: false,
      before: {},
    });

    const r = reconcileLive(run.dir);
    expect(r.finished.map((x) => x.status)).toEqual(["ok"]);
    expect(readRunRecords(run.dir)).toHaveLength(1);
    expect(readLive(run.dir)).toEqual([]);
  });

  test("leaves a run whose process is alive", () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeLive(run.dir, {
      name: "w",
      role: "worker",
      backend: "codex",
      rung: "gpt-6-sol#medium",
      pid: process.pid,
      thread: null,
      startedAt: new Date().toISOString(),
      cwd: repo,
      ownedFiles: [],
      isolated: false,
      before: {},
    });
    const r = reconcileLive(run.dir);
    expect(r.finished).toEqual([]);
    expect(r.stillRunning.map((m) => m.name)).toEqual(["w"]);
  });
});

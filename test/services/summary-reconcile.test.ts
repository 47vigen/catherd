import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runsDir } from "../../src/infra/paths.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
import {
  appendAgentRun,
  appendLedger,
  appendRecord,
  appendRoute,
  readRecords,
  runPaths,
} from "../../src/services/run-store.ts";
import { runsSummary, status, summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { deadProcess, fakeDeps, fakeDispatch, fakeGit, freshRun, makeRecord, testView } from "./helpers.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const finished = () => ({
  code: 0,
  signal: null,
  reason: "exited" as const,
  endedAt: new Date().toISOString(),
});

/** Every file under `dir` with its size and mtime: equal before and after means nothing was written. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = `${statSync(p).size}:${statSync(p).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

describe("status and summaries", () => {
  it("sums records, reported subagents, Jev fallbacks, live roles, milestones and the budget", async () => {
    const { run } = freshRun();
    await appendRecord(
      run,
      makeRecord({ dispatchId: "D1", tokens: { input: 100, cached: 10, output: 20 }, costUsd: 0.5 }),
    );
    await appendRecord(run, makeRecord({ dispatchId: "D2", name: "w2", status: "limit", replyStatus: null }));
    appendAgentRun(run, {
      at: "x",
      name: "architect",
      role: "architect",
      rung: "claude:claude-opus-5-5#high",
      agent: "a",
      totalTokens: 900,
      costUsd: null,
      secs: 60,
      status: "ok",
    });
    writeFileSync(runPaths(run.dir).jev, '{"source":"jev"}\n{"source":"default"}\n');
    appendLedger(run, "M1 | login | abc1234 | 12 | bun test");
    await fakeDispatch(run, { name: "w3" }, { proc: "self" });
    const deps = fakeDeps({ view: testView({ budget: { tokens: 10_000 } }) });
    const s = summarizeRun(deps, run);
    expect(s.totals).toMatchObject({
      runs: 2,
      ok: 1,
      notOk: ["w2 (limit)"],
      tokens: { input: 200, cached: 50, output: 30 },
      costUsd: 0.5,
    });
    expect(s.agents).toEqual({ runs: 1, totalTokens: 900, costUsd: 0 });
    expect(s.jev).toEqual({ decisions: 2, fallbacks: 1 });
    expect(s.live.map((l) => [l.name, l.state])).toEqual([["w3", "running"]]);
    expect(s.milestones).toEqual(["M1 | login | abc1234 | 12 | bun test"]);
    expect(s.budget?.tokens).toEqual({ spent: 1130, cap: 10_000 });
  });

  it("never writes: a finished dispatch without a record stays unrecorded after status", async () => {
    const { run } = freshRun();
    await fakeDispatch(run, {}, { proc: "dead", exit: finished(), reply: "x\nSTATUS: complete — ok" });
    const before = tree(run.dir);
    const deps = fakeDeps();
    status(deps, run.id);
    status(deps);
    summarizeRun(deps, run);
    runsSummary({});
    expect(tree(run.dir)).toEqual(before);
    expect(readRecords(run).records).toEqual([]);
  });

  it("without a run, shows the runs with live roles, else the newest, and warns about a corrupt one", async () => {
    const { repo, run } = freshRun("first");
    const deps = fakeDeps();
    expect(status(deps).runs.map((r) => r.id)).toEqual([run.id]);
    mkdirSync(join(runsDir(repo), "broken"));
    writeFileSync(join(runsDir(repo), "broken", "meta.json"), "{");
    const s = status(deps);
    expect(s.version).toBe("0.0.0-test");
    expect(s.warnings.join()).toContain("skipped run broken");
  });

  it("reads a run whose runs.jsonl ends in a torn line", async () => {
    const { run } = freshRun();
    await appendRecord(run, makeRecord({ dispatchId: "D1" }));
    appendFileSync(runPaths(run.dir).runs, '{"schema":1,"ru');
    const s = summarizeRun(fakeDeps(), run);
    expect(s.totals.runs).toBe(1);
    expect(s.warnings).toEqual(["runs.jsonl: skipped 1 unreadable row(s)"]);
  });

  it("groups records per role and rung with refusals and climbs, and reports native runs apart", async () => {
    const { run } = freshRun();
    await appendRecord(
      run,
      makeRecord({ dispatchId: "D1", rung: "codex:a#low", replyStatus: "refused", secs: 30 }),
    );
    await appendRecord(run, makeRecord({ dispatchId: "D2", rung: "codex:a#high", secs: 60 }));
    appendRoute(run, {
      at: "x",
      lane: "M1.L1",
      role: "worker",
      rung: "codex:a#high",
      ladder: [],
      source: "climb",
      decidedBy: "lane",
      from: "codex:a#low",
      reason: "refused",
      kind: null,
      difficulty: null,
    });
    appendAgentRun(run, {
      at: "x",
      name: "v",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 5,
      costUsd: null,
      secs: 7,
      status: "ok",
    });
    const s = runsSummary({ run: run.id });
    expect(s.rungs.map((r) => [r.rung, r.runs, r.refusals, r.climbsFrom])).toEqual([
      ["codex:a#high", 1, 0, 0],
      ["codex:a#low", 1, 1, 1],
    ]);
    expect(s.agents).toEqual([{ rung: "claude:claude-opus-5-5#low", runs: 1, totalTokens: 5, secs: 7 }]);
  });
});

describe("reconcileAll", () => {
  it("finalizes finished dispatches, leaves recorded ones, and skips a corrupt run with a warning", async () => {
    const { repo, run } = freshRun();
    const done = await fakeDispatch(
      run,
      { name: "a" },
      {
        proc: "dead",
        exit: finished(),
        events: readFileSync(join(FX, "two-turns.jsonl"), "utf8"),
        reply: "x\nSTATUS: complete — ok",
      },
    );
    const recorded = await fakeDispatch(run, { name: "b" }, { proc: "dead", exit: finished() });
    await appendRecord(run, makeRecord({ dispatchId: recorded.admit.dispatchId, name: "b" }));
    mkdirSync(join(runsDir(repo), "broken"));
    writeFileSync(join(runsDir(repo), "broken", "meta.json"), "{");
    const r = await reconcileAll(fakeDeps());
    expect(r.finalized).toEqual([done.admit.dispatchId]);
    expect(r.warnings.join()).toContain("skipped run broken");
    expect(
      readRecords(run)
        .records.map((x) => x.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("watches a live dispatch it did not start and finalizes it when the worker exits", async () => {
    const { run } = freshRun();
    const worker = Bun.spawn(["sleep", "0.5"]);
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: {
          pid: worker.pid,
          startTime: processStartTime(worker.pid),
          supervisorPid: await deadProcess(),
          supervisorStartTime: "gone",
        },
      },
    );
    const r = await reconcileAll(fakeDeps());
    expect(r.watching).toEqual([d.admit.dispatchId]);
    expect(readRecords(run).records).toEqual([]);
    await r.done;
    expect(readRecords(run).records.map((x) => x.dispatchId)).toEqual([d.admit.dispatchId]);
  });

  it("writes one record when two reconcilers race over the same dispatches", async () => {
    const { run } = freshRun();
    for (const name of ["a", "b", "c"])
      await fakeDispatch(run, { name }, { proc: "dead", exit: finished(), reply: "x" });
    await Promise.all([reconcileAll(fakeDeps()), reconcileAll(fakeDeps())]);
    expect(readRecords(run).records).toHaveLength(3);
    expect(readFileSync(runPaths(run.dir).runs, "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("finalizes with git broken, the changes unknown, and warns that state.md was not refreshed", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { proc: "dead", exit: finished(), reply: "x" });
    fakeGit("exit 128");
    const r = await reconcileAll(fakeDeps());
    expect(r.finalized).toEqual([d.admit.dispatchId]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(new RegExp(`^${run.id}: state\\.md not refreshed: git status failed`));
    expect(readRecords(run).records).toMatchObject([{ changedOwned: [], gitUnavailable: true }]);
  });
});

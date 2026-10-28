import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { newDispatchId } from "../../src/domain/ids.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { logFile } from "../../src/infra/log.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { appendEvent, eventsFile } from "../../src/services/run-events-store.ts";
import { RunCardSchema, runIndex, runIndexCache } from "../../src/services/run-index.ts";
import { appendRecord, appendRoute, createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { interventionsOf } from "../../src/services/scorecard-metrics.ts";
import { makeRecord } from "../domain/make-record.ts";
import { PLAN, endDispatch, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());
const real = daemonLauncher.launch;
let launched: string[] = [];
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  launched = [];
  daemonLauncher.launch = (id: string) => {
    launched.push(id);
    return 1;
  };
  runIndexCache.clear();
});
afterEach(() => {
  daemonLauncher.launch = real;
});

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (agoMs: number): Date => new Date(NOW - agoMs);
const deps = () => fakeDeps({ now: () => NOW });

/** A 2.0 run created `agoMs` before NOW in `repo`, with its plan approved and then `more`. */
async function make(repo: string, title: string, agoMs: number, ...more: RunEventInput[]): Promise<Run> {
  const run = createRun({ repo, title, aLines: ["A1 ok"], version: "0.0.0-test", now: at(agoMs) });
  await appendEvent(run, { type: "run.started", ...startedFields, repo, title }, at(agoMs));
  await appendEvent(run, { type: "plan.ready", milestones: PLAN }, at(agoMs - 1000));
  await appendEvent(run, { type: "plan.approved", by: "input" }, at(agoMs - 1000));
  for (const e of more) await appendEvent(run, e, at(agoMs - 2000));
  return run;
}

const record = (run: Run, over: Parameters<typeof makeRecord>[0]) =>
  appendRecord(run, makeRecord({ runId: run.id, dispatchId: newDispatchId(), ...over }));

describe("the run index", () => {
  it("leaves an earlier build's torn events tail byte for byte as it found it", () => {
    withHome();
    const repo = tempRepo();
    const run = createRun({ repo, title: "earlier", aLines: [], version: "0.0.0-test", now: at(HOUR) });
    const log = makeLog();
    log.add("run.started", { ...startedFields, repo, title: "earlier" });
    const text = `${log.events.map((e) => JSON.stringify(e)).join("\n")}\n{"v":1,"seq":2,"at":"x","ty`;
    writeFileSync(eventsFile(run), text);
    chmodSync(eventsFile(run), 0o400);
    expect(runIndex(deps())).toHaveLength(1);
    expect(readFileSync(eventsFile(run), "utf8")).toBe(text);
  });

  it("lists every repo's runs newest first, a 1.5 run read-only", async () => {
    withHome();
    const [a, b] = [tempRepo(), tempRepo()] as [string, string];
    const old = await make(a, "older", 3 * HOUR);
    const legacy = createRun({ repo: b, title: "legacy", aLines: [], version: "0.0.0-test", now: at(HOUR) });
    const cards = runIndex(deps());
    expect(cards.map((c) => c.id)).toEqual([legacy.id, old.id]);
    expect(cards.map((c) => RunCardSchema.parse(c))).toEqual(cards);
    expect(cards[0]).toMatchObject({ engine: "1.5", phase: null, outcome: null, repo: b, title: "legacy" });
    expect(cards[1]).toMatchObject({ engine: "2.0", phase: "running", endedAt: null, wallMinutes: null });
    expect(cards[1]?.milestones).toEqual({ total: 2, landed: 0 });
    expect(runIndex(deps(), { repo: a }).map((c) => c.id)).toEqual([old.id]);
  });

  it("leaves the run's own pauses out of its wall time", async () => {
    withHome();
    const run = await make(tempRepo(), "paused", HOUR);
    await appendEvent(run, { type: "run.paused", by: "owner" }, at(HOUR - 10 * 60_000));
    await appendEvent(run, { type: "run.resumed", by: "owner" }, at(HOUR - 30 * 60_000));
    await appendEvent(run, { type: "run.ended", outcome: "done", reportPath: null }, at(0));
    expect(runIndex(deps())[0]?.wallMinutes).toBe(40);
    const live = await make(tempRepo(), "on hold", HOUR / 2, { type: "run.paused", by: "owner" });
    expect(runIndex(deps()).find((c) => c.id === live.id)?.paused).toBe(at(HOUR / 2 - 2000).toISOString());
  });

  it("sums tokens, cost and time per backend, model and role from runs.jsonl", async () => {
    withHome();
    const run = await make(tempRepo(), "spend", HOUR);
    await record(run, { tokens: { input: 100, cached: 40, output: 10 }, costUsd: 0.5, secs: 60 });
    await record(run, { tokens: { input: 200, cached: 0, output: 20 }, costUsd: null, secs: 30 });
    await record(run, {
      backend: "claude-code",
      rung: "claude-code:opus#high",
      role: "reviewer",
      tokens: { input: 1000, cached: 0, output: 100 },
      costUsd: 2,
      secs: 120,
    });
    const [c] = runIndex(deps());
    expect(c?.totals).toMatchObject({
      dispatches: 3,
      tokens: { input: 1300, cached: 40, output: 130 },
      costUsd: 2.5,
    });
    expect(c?.byBackend).toEqual([
      { backend: "codex", tokens: 330, costUsd: 0.5 },
      { backend: "claude-code", tokens: 1100, costUsd: 2 },
    ]);
    expect(c?.byModel).toEqual([
      { model: "codex:gpt-6-sol", tokens: 330 },
      { model: "claude-code:opus", tokens: 1100 },
    ]);
    expect(c?.byRole).toEqual([
      { role: "worker", secs: 90 },
      { role: "reviewer", secs: 120 },
    ]);
  });

  it("an unpriced run is counted, not zero", async () => {
    withHome();
    const run = await make(tempRepo(), "unpriced", HOUR);
    await record(run, { costUsd: null, tokens: { input: 100, cached: 20, cacheWrite: 30, output: 10 } });
    expect(runIndex(deps())[0]?.totals).toMatchObject({
      costUsd: null,
      unpriced: 1,
      tokens: { input: 100, cached: 20, cacheWrite: 30, output: 10 },
    });
    await record(run, { costUsd: 0, tokens: { input: 50, cached: 0, output: 5 } });
    expect(runIndex(deps())[0]?.totals).toMatchObject({
      costUsd: 0,
      unpriced: 1,
      tokens: { input: 150, cached: 20, cacheWrite: 30, output: 15 },
    });
    await record(run, { costUsd: 2.5 });
    expect(runIndex(deps())[0]?.totals).toMatchObject({ costUsd: 2.5, unpriced: 1 });
  });

  it("counts completed review rounds rather than commit fix rounds", async () => {
    withHome();
    const run = await make(tempRepo(), "reviewed", HOUR, {
      type: "commit.made",
      milestone: "M1",
      round: 0,
      commit: "abc",
    });
    const log = makeLog();
    const id = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, id, { name: "reviewer-M1", unit: "M1" });
    for (const { v: _v, seq: _seq, at: _at, ...e } of log.events) await appendEvent(run, e, at(0));
    expect(runIndex(deps())[0]?.totals.rounds).toBe(1);
  });

  it("counts failovers, climbs, rounds and interventions", async () => {
    withHome();
    const run = await make(
      tempRepo(),
      "busy",
      HOUR,
      { type: "commit.made", milestone: "M1", round: 2, commit: "abc" },
      { type: "question.parked", unit: "M1.L1", question: "which?", reason: "needs_user" },
    );
    await record(run, { failoverFrom: "codex:gpt-6-sol#medium" });
    await record(run, {});
    const row = {
      at: at(0).toISOString(),
      lane: "M1.L1",
      role: "worker" as const,
      rung: "codex:gpt-6-sol#high",
      ladder: [],
      decidedBy: "default" as never,
      from: null,
      reason: null,
      kind: null,
      difficulty: null,
    };
    appendRoute(run, { ...row, source: "route" });
    appendRoute(run, { ...row, source: "climb" });
    await appendEvent(run, { type: "question.answered", unit: "M1.L1", answer: "yes", by: "owner" }, at(0));
    const [c] = runIndex(deps());
    expect(c?.totals).toMatchObject({ failovers: 1, climbs: 1, rounds: 0 });
    expect(c?.totals.interventions).toBe(interventionsOf(run, NOW, 0).total);
    expect(c?.totals.interventions).toBeGreaterThan(0);
    expect(c?.openQuestions).toBe(0);
  });

  it("a second read recomputes only the run whose files changed", async () => {
    withHome();
    const repo = tempRepo();
    const a = await make(repo, "a", 2 * HOUR);
    await make(repo, "b", HOUR);
    runIndex(deps());
    const first = runIndexCache.computed;
    runIndex(deps());
    expect(runIndexCache.computed).toBe(first);
    await appendEvent(a, { type: "tick" }, at(0));
    runIndex(deps());
    expect(runIndexCache.computed).toBe(first + 1);
  });

  it("a run whose events cannot be read is left out, and the others are listed", async () => {
    withHome();
    const repo = tempRepo();
    const torn = await make(repo, "torn", 3 * HOUR);
    const newer = await make(repo, "newer", 2 * HOUR);
    const ok = await make(repo, "ok", HOUR);
    appendFileSync(eventsFile(torn), '{"v":1,\n');
    appendFileSync(
      eventsFile(newer),
      `${JSON.stringify({ v: 99, seq: 4, at: at(0).toISOString(), type: "tick" })}\n`,
    );
    expect(runIndex(deps()).map((c) => c.id)).toEqual([ok.id]);
  });

  it("logs a run with an unreadable meta.json once and lists the others", async () => {
    withHome();
    process.env.CATHERD_LOG = "warn";
    const repo = tempRepo();
    const bad = await make(repo, "bad", 2 * HOUR);
    const good = await make(repo, "good", HOUR);
    writeFileSync(runPaths(bad.dir).meta, "{not json");
    expect(runIndex(deps()).map((c) => c.id)).toEqual([good.id]);
    expect(runIndex(deps()).map((c) => c.id)).toEqual([good.id]);
    const warnings = (existsSync(logFile()) ? readFileSync(logFile(), "utf8") : "")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === "index" && row.corrupt);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", run: bad.id, dir: bad.dir });
  });

  it("drops the cached card of a run that was deleted", async () => {
    withHome();
    const repo = tempRepo();
    const a = await make(repo, "a", 2 * HOUR);
    const b = await make(repo, "b", HOUR);
    runIndex(deps());
    expect(runIndexCache.size).toBe(2);
    rmSync(a.dir, { recursive: true, force: true });
    expect(runIndex(deps()).map((c) => c.id)).toEqual([b.id]);
    expect(runIndexCache.size).toBe(1);
  });

  it("a repo-filtered read keeps other repos' cached cards", async () => {
    withHome();
    const repo = tempRepo();
    const a = await make(repo, "a", 2 * HOUR);
    const b = await make(tempRepo(), "b", HOUR);
    runIndex(deps());
    expect(runIndexCache.size).toBe(2);
    expect(runIndex(deps(), { repo }).map((c) => c.id)).toEqual([a.id]);
    expect(runIndexCache.size).toBe(2);
    const computed = runIndexCache.computed;
    expect(runIndex(deps()).map((c) => c.id)).toEqual([b.id, a.id]);
    expect(runIndexCache.computed).toBe(computed);
  });

  it("reading the index starts no daemon", async () => {
    withHome();
    await make(tempRepo(), "dead daemon", HOUR);
    expect(runIndex(deps())).toHaveLength(1);
    expect(launched).toEqual([]);
  });
});

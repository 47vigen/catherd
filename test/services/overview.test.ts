import { afterEach, describe, expect, it } from "bun:test";
import { newDispatchId } from "../../src/domain/ids.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { overview } from "../../src/services/overview.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { runIndexCache } from "../../src/services/run-index.ts";
import { appendRecord, createRun, type Run } from "../../src/services/run-store.ts";
import { makeRecord } from "../domain/make-record.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;
const MIN = 60_000;
const deps = () => fakeDeps({ now: () => NOW });

/** A 2.0 run started at `start` (epoch ms), approved by input, then `more` one second apart. */
async function make(repo: string, title: string, start: number, ...more: RunEventInput[]): Promise<Run> {
  const run = createRun({ repo, title, aLines: ["A1 ok"], version: "0.0.0-test", now: new Date(start) });
  await appendEvent(run, { type: "run.started", ...startedFields, repo, title }, new Date(start));
  await appendEvent(run, { type: "plan.ready", milestones: PLAN }, new Date(start + 1000));
  await appendEvent(run, { type: "plan.approved", by: "input" }, new Date(start + 1000));
  for (const e of more) await appendEvent(run, e, new Date(start + 2000));
  return run;
}

/** `make`, ended `done` after `minutes`. */
async function ended(repo: string, title: string, start: number, minutes: number): Promise<Run> {
  const run = await make(repo, title, start);
  await appendEvent(
    run,
    { type: "run.ended", outcome: "done", reportPath: null },
    new Date(start + minutes * MIN),
  );
  return run;
}

const range = { from: NOW - 7 * DAY + 1, to: NOW };
const spend = (run: Run, over: Parameters<typeof makeRecord>[0]) =>
  appendRecord(run, makeRecord({ runId: run.id, dispatchId: newDispatchId(), ...over }));

describe("the overview", () => {
  it("counts only runs started in the range and the repo", async () => {
    withHome();
    runIndexCache.clear();
    const [a, b] = [tempRepo(), tempRepo()] as [string, string];
    const inA = await make(a, "in a", NOW - DAY);
    await make(b, "in b", NOW - DAY);
    await make(a, "too old", NOW - 20 * DAY);
    const all = overview(deps(), range);
    expect(all.kpis.runs).toBe(2);
    expect(all.repos.toSorted()).toEqual([a, b].toSorted());
    const one = overview(deps(), { ...range, repo: a });
    expect(one.kpis.runs).toBe(1);
    expect(one.repo).toBe(a);
    expect(one.recent.map((r) => r.id)).toEqual([inA.id]);
  });

  it("a clean run ended done with no intervention, and the median wall time is of ended runs", async () => {
    withHome();
    runIndexCache.clear();
    const repo = tempRepo();
    await ended(repo, "ten", NOW - 3 * DAY, 10);
    const thirty = await ended(repo, "thirty", NOW - 2 * DAY, 30);
    await make(repo, "live", NOW - DAY);
    await appendEvent(thirty, {
      type: "question.parked",
      unit: "M1.L1",
      question: "q",
      reason: "needs_user",
    });
    const k = overview(deps(), range).kpis;
    expect(k).toMatchObject({ runs: 3, ended: 2, medianWallMinutes: 20 });
    // the second run parked and was answered by nobody after it ended: it still counts an intervention
    expect(k.clean).toBe(1);
    expect(k.cleanPct).toBe(50);
    expect(k.interventions).toBeGreaterThan(0);
  });

  it("daily buckets are zero-filled UTC days, a run's spend on its start day", async () => {
    withHome();
    runIndexCache.clear();
    const repo = tempRepo();
    const start = Date.parse("2026-10-18T23:30:00.000Z");
    const run = await make(repo, "late", start);
    await spend(run, { tokens: { input: 100, cached: 0, output: 50 }, costUsd: 1 });
    const from = Date.parse("2026-10-15T00:00:00.000Z");
    const o = overview(deps(), { from, to: from + 7 * DAY - 1 });
    expect(o.daily.map((d) => d.day)).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]);
    expect(o.daily.filter((d) => d.backends.length === 0)).toHaveLength(6);
    expect(o.daily[3]).toEqual({
      day: "2026-10-18",
      backends: [{ backend: "codex", tokens: 150, costUsd: 1 }],
    });
    expect(o.kpis).toMatchObject({ tokens: 150, costUsd: 1 });
  });

  it("tokens by model keep the first eight and fold the rest into other", async () => {
    withHome();
    runIndexCache.clear();
    const run = await make(tempRepo(), "many", NOW - DAY);
    for (let i = 1; i <= 10; i++)
      await spend(run, { rung: `codex:model-${i}#medium`, tokens: { input: i, cached: 0, output: 0 } });
    const m = overview(deps(), range).tokensByModel;
    expect(m).toHaveLength(9);
    expect(m[0]).toEqual({ model: "codex:model-10", tokens: 10 });
    expect(m[8]).toEqual({ model: "other", tokens: 3 });
  });

  it("live runs carry the now lines nowOf gives, whatever their start", async () => {
    withHome();
    runIndexCache.clear();
    const repo = tempRepo();
    const old = await make(repo, "old but live", NOW - 30 * DAY);
    await ended(repo, "finished", NOW - DAY, 5);
    const line = { node: "M1.L1", title: "M1.L1", text: "Codex is writing", rung: "codex:gpt-6-sol#medium" };
    const o = overview(deps(), range, (id) => (id === old.id ? [line] : []));
    expect(o.live.map((l) => l.run.id)).toEqual([old.id]);
    expect(o.live[0]?.now).toEqual([line]);
    expect(overview(deps(), range).live[0]?.now).toEqual([]);
  });

  it("questions gives the total and the first five", async () => {
    withHome();
    runIndexCache.clear();
    const repo = tempRepo();
    for (let i = 0; i < 4; i++)
      await make(
        repo,
        `r${i}`,
        NOW - (i + 1) * DAY,
        { type: "question.parked", unit: "M1.L1", question: "a", reason: "needs_user" },
        { type: "question.parked", unit: "M1.L2", question: "b", reason: "needs_user" },
      );
    const q = overview(deps(), range).questions;
    expect(q.total).toBe(8);
    expect(q.first).toHaveLength(5);
  });
});

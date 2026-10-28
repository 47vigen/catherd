import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeRow, RouteRow } from "../../src/domain/route.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { laneRecords, outcomeStats } from "../../src/services/outcome-summary.ts";
import { appendEvents } from "../../src/services/run-events-store.ts";
import { appendOutcome, appendRoute, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const RUNG = "codex:gpt-6.1-sol#high";
const AT = "2026-10-24T10:00:00.000Z";

const route = (o: Partial<RouteRow> = {}): RouteRow => ({
  at: AT,
  lane: "M1.L1",
  role: "worker",
  rung: RUNG,
  ladder: [RUNG],
  source: "route",
  decidedBy: "lane",
  from: null,
  reason: null,
  kind: "repo_code",
  difficulty: "build",
  ...o,
});
const outcome = (o: Partial<OutcomeRow> = {}): OutcomeRow => ({
  at: AT,
  lane: "M1.L1",
  source: "lane",
  startRung: RUNG,
  finalRung: RUNG,
  climbs: [],
  landed: true,
  start_ok: true,
  min_ok_index: 0,
  envCaused: false,
  ...o,
});
const started = (dispatchId: string, role: "worker" | "reviewer", lane: string | null): RunEventInput => ({
  type: "dispatch.started",
  dispatchId,
  name: `${role}-${lane ?? "M1"}`,
  role,
  unit: lane ?? "M1",
  lane,
  rung: RUNG,
  thread: null,
});
const reviewed = (findings: { label: "BLOCKER" | "BUG" | "NIT"; file: string | null }[]): RunEventInput => ({
  type: "dispatch.ended",
  dispatchId: "R1",
  name: "reviewer-M1",
  unit: "M1",
  status: "ok",
  replyStatus: "complete",
  reason: null,
  why: "",
  thread: null,
  head: null,
  environment: null,
  verdict: "fail",
  findings: findings.map((f) => ({ ...f, text: "x" })),
  replyPath: "reply.md",
});

async function finishedRun(): Promise<Run> {
  const { run } = freshRun();
  await appendEvents(run, [
    started("W1", "worker", "M1.L1"),
    started("W2", "worker", "M1.L1"),
    started("R1", "reviewer", null),
    reviewed([
      { label: "BUG", file: "src/a/x.ts" },
      { label: "BUG", file: "src/b/y.ts" },
      { label: "NIT", file: "src/a/z.ts" },
    ]),
  ]);
  appendRoute(run, route());
  appendOutcome(run, outcome());
  return run;
}

describe("laneRecords", () => {
  it("turns a daemon run's finished lane into a record", async () => {
    const run = await finishedRun();
    expect(laneRecords(run)).toEqual([
      {
        rung: RUNG,
        kind: "repo_code",
        difficulty: "build",
        landed: true,
        firstPass: false,
        rounds: 2,
        // plan 48: no plan of lanes pins a finding to a lane any more
        findings: 0,
      },
    ]);
  });

  it("counts a landed lane with one dispatch as a first pass", async () => {
    const { run } = freshRun();
    await appendEvents(run, [started("W1", "worker", "M1.L1")]);
    appendRoute(run, route());
    appendOutcome(run, outcome());
    expect(laneRecords(run)[0]).toMatchObject({ firstPass: true, rounds: 1, findings: 0 });
  });

  it("gives nothing for a 1.x run", async () => {
    const { run } = freshRun();
    appendRoute(run, route());
    appendOutcome(run, outcome());
    rmSync(join(run.dir, "events.jsonl"), { force: true });
    expect(laneRecords(run)).toEqual([]);
    await appendEvents(run, [started("W1", "worker", "M1.L1")]);
    expect(laneRecords(run)).toHaveLength(1);
  });

  it("gives nothing, and does not throw, for an unreadable events file", async () => {
    const run = await finishedRun();
    writeFileSync(join(run.dir, "events.jsonl"), "not json\n{}\n");
    expect(laneRecords(run)).toEqual([]);
  });
});

describe("outcomeStats", () => {
  it("sums the records of the runs it is given, chore lanes apart", async () => {
    const a = await finishedRun();
    const dir = mkdtempSync(join(tmpdir(), "catherd-no-events-"));
    const stats = outcomeStats([a, a, { ...a, dir }]);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      model: "codex:gpt-6.1-sol",
      effort: "high",
      lanes: 2,
      rounds: 4,
      findings: 0,
    });
  });
});

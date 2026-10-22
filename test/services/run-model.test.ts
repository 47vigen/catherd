import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunModelSchema } from "../../src/domain/run-graph.ts";
import { appendRecord } from "../../src/services/run-store.ts";
import { eventsFile } from "../../src/services/run-events-store.ts";
import { questionContext, QuestionContextSchema, runModel } from "../../src/services/run-model.ts";
import { makeRecord } from "../domain/make-record.ts";
import { snapshotEnv } from "../helpers.ts";
import { seedFixtureRun } from "./fixture-run.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const node = (m: ReturnType<typeof runModel>, id: string) => {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

describe("the run model service", () => {
  it("the case-helpers run: every node done, two rounds on the lane, the commit and the review", () => {
    freshRun();
    const run = seedFixtureRun();
    const m = RunModelSchema.parse(runModel(run.id));
    expect(m.engine).toBe("2.0");
    expect(m.phase).toBe("ended");
    expect(m.outcome).toBe("done");
    expect(m.nodes.map((n) => [n.id, n.status])).toEqual([
      ["start", "done"],
      ["architect", "done"],
      ["M1/route", "done"],
      ["M1/preflight", "done"],
      ["M1/lane/M1.L1", "done"],
      ["M1/check/M1.L1", "done"],
      ["M1/commit", "done"],
      ["M1/review", "done"],
      ["M1/verify", "done"],
      ["M1/land", "done"],
      ["judge", "done"],
      ["report", "done"],
      ["end", "done"],
    ]);
    const lane = node(m, "M1/lane/M1.L1");
    expect(lane.attempts.map((a) => a.label)).toEqual(["round 1", "round 0"]);
    expect(lane.attempts[1]?.tokens?.output).toBe(7845);
    expect(lane.attempts[0]?.tokens?.output).toBe(10630);
    expect(node(m, "M1/commit").attempts.map((a) => a.label)).toEqual(["round 1", "round 0"]);
    expect(node(m, "M1/review").attempts.map((a) => a.label)).toEqual(["round 1", "round 0"]);
    expect(node(m, "architect").attempts[0]?.costUsd).toBeCloseTo(0.687, 2);
    expect(node(m, "judge").attempts.map((a) => a.label)).toEqual(["rules"]);
    expect(m.dispatches.length).toBe(7);
    expect(m.dispatches[0]?.name).toBe("judge-rules");
  });

  it("a 1.5 run has no nodes and lists its dispatch records", async () => {
    const { run } = freshRun();
    await appendRecord(run, makeRecord({ runId: run.id, dispatchId: "D1", name: "worker-M1.L1" }));
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: "D2",
        name: "reviewer-M1",
        role: "reviewer",
        lane: null,
        startedAt: "2026-09-25T10:05:00.000Z",
      }),
    );
    const m = runModel(run.id);
    expect(m.engine).toBe("1.5");
    expect(m.nodes).toEqual([]);
    expect(m.edges).toEqual([]);
    expect(m.dispatches.map((d) => d.dispatchId)).toEqual(["D2", "D1"]);
    expect(m.dispatches[0]?.role).toBe("reviewer");
  });

  it("a question's context names its node and the asking role's latest reply", () => {
    freshRun();
    const run = seedFixtureRun();
    appendFileSync(
      eventsFile(run),
      `${JSON.stringify({ v: 1, seq: 30, at: "2026-10-22T19:30:00.000Z", type: "question.parked", unit: "M1.L1", question: "Which way?", reason: "needs_user" })}\n`,
    );
    const c = QuestionContextSchema.parse(questionContext(run.id, "M1.L1"));
    expect(c.node).toBe("M1/lane/M1.L1");
    expect(c.lane).toBe("M1.L1");
    expect(c.replyName).toBe("worker-M1.L1");
    const latest = readFileSync(
      join(run.dir, "roles/worker-M1.L1/01M5JH6H07PPTN0QJAZDRXG3EY/reply.md"),
      "utf8",
    );
    expect(c.reply).toBe(latest);
    expect(runModel(run.id).nodes.find((n) => n.status === "parked")?.id).toBeUndefined();
  });

  it("a question without a reply still has its node", () => {
    freshRun();
    const run = seedFixtureRun();
    appendFileSync(
      eventsFile(run),
      `${JSON.stringify({ v: 1, seq: 30, at: "2026-10-22T19:30:00.000Z", type: "question.parked", unit: "run", question: "Budget?", reason: "budget" })}\n`,
    );
    expect(questionContext(run.id, "run")).toEqual({
      node: "start",
      reply: null,
      replyName: null,
      lane: null,
    });
  });

  it("the fixture holds no home path", () => {
    const dir = join(import.meta.dir, "..", "fixtures", "runs", "case-helpers");
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.includes("."));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(dir, f), "utf8");
      } catch {
        continue;
      }
      expect(text.includes("/Users/")).toBe(false);
    }
  });
});

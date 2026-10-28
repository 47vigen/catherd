import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  it("an earlier build's run (spec D16): every role it ran draws as a node of its own, read-only", () => {
    freshRun();
    const run = seedFixtureRun();
    const m = RunModelSchema.parse(runModel(run.id));
    expect([m.engine, m.phase, m.outcome]).toEqual(["2.0", "ended", "done"]);
    expect(m.nodes.map((n) => [n.id, n.status])).toEqual([
      ["start", "done"],
      ["architect", "done"],
      ["task/worker-M1.L1", "done"],
      ["task/reviewer-M1", "done"],
      ["task/verifier-M1", "done"],
      ["end", "done"],
    ]);
    const lane = node(m, "task/worker-M1.L1");
    expect(lane.attempts.map((a) => a.tokens?.output)).toEqual([10630, 7845]);
    expect(node(m, "task/reviewer-M1").attempts).toHaveLength(2);
    expect(node(m, "architect").attempts[0]?.costUsd).toBeCloseTo(0.687, 2);
    // plan 49 R14: the judge left ROLES, so the earlier run's judge dispatch is skipped
    expect(m.dispatches.length).toBe(6);
    expect(m.dispatches[0]?.name).toBe("verifier-M1");
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
    expect(c.node).toBe("task/worker-M1.L1");
    expect(c.lane).toBe("M1.L1");
    expect(c.replyName).toBe("worker-M1.L1");
    const latest = readFileSync(
      join(run.dir, "roles/worker-M1.L1/01M5JH6H07PPTN0QJAZDRXG3EY/reply.md"),
      "utf8",
    );
    expect(c.reply).toBe(latest);
    expect(runModel(run.id).nodes.find((n) => n.status === "parked")?.id).toBeUndefined();
  });

  it("a question of the run goes to the architect, with its latest reply", () => {
    freshRun();
    const run = seedFixtureRun();
    appendFileSync(
      eventsFile(run),
      `${JSON.stringify({ v: 1, seq: 30, at: "2026-10-22T19:30:00.000Z", type: "question.parked", unit: "run", question: "Budget?", reason: "budget" })}\n`,
    );
    const c = questionContext(run.id, "run");
    expect(c).toMatchObject({ node: "architect", replyName: "architect", lane: null });
    expect(c.reply).toContain("STATUS: complete");
  });

  it("the fixtures hold no home path and no trace of the machine they were recorded on", () => {
    const fixtures = join(import.meta.dir, "..", "fixtures");
    const files = ["runs/case-helpers", "transcript"].flatMap((d) =>
      (readdirSync(join(fixtures, d), { recursive: true }) as string[])
        .map((f) => join(fixtures, d, f))
        .filter((f) => statSync(f).isFile()),
    );
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith("stderr"))).toBe(true);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const trace of ["/Users/", "/agora/", "trypulse", "honcho"])
        expect(text.includes(trace), `${f} holds "${trace}"`).toBe(false);
    }
  });
});

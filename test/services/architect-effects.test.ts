import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonLimits, runDaemon } from "../../src/services/daemon.ts";
import { watchersSettled } from "../../src/services/dispatch-service.ts";
import { writeTextAtomic } from "../../src/infra/store.ts";
import { taskBriefFile } from "../../src/services/architect-run.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { readRecords } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());
afterEach(() => watchersSettled());
const limits = { ...daemonLimits };
beforeEach(() => {
  daemonLimits.beatMs = 0;
});
afterEach(() => Object.assign(daemonLimits, limits));

const SOL = "codex:gpt-6-sol#high";

describe("an architect run on the real effects (plan 47, spec D1–D3)", () => {
  it("runs a delegated task, wakes the architect with a digest, and stops when two turns start nothing", async () => {
    const { run } = freshRun("wallet");
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ reply: "Done.\nSTATUS: complete — ok" }).env);
    const view = testView();
    view.roles.architect = { enabled: true, access: "workspace-write", rungs: [SOL] };
    const deps = fakeDeps({ view });
    await appendEvent(run, {
      type: "run.started",
      ...startedFields,
      repo: run.meta.repo,
      title: "wallet",
    });
    writeTextAtomic(
      join(run.dir, taskBriefFile("T1")),
      "Write src/wallet.ts: a Wallet class with balance().",
    );
    await appendEvent(run, {
      type: "task.delegated",
      taskId: "T1",
      role: "worker",
      rung: SOL,
      thread: null,
      ledgerTask: null,
      by: "architect",
      why: "the wallet first",
    });
    const clock = { now: Date.now, sleep: () => new Promise<void>((r) => setImmediate(r)) };
    expect(await runDaemon(deps, run.id, { clock })).toBe("ended");
    const events = readEvents(run);
    const started = events.flatMap((e) => (e.type === "dispatch.started" ? [e] : []));
    expect(started.map((e) => e.name)).toEqual(expect.arrayContaining(["T1", "architect-1", "architect-2"]));
    expect(started.find((e) => e.name === "architect-1")).toMatchObject({
      rung: SOL,
      upTo: expect.any(Number),
    });
    expect(events.at(-1)).toMatchObject({ type: "run.ended", outcome: "failed" });
    // the task's brief is its caller's text, with no lane
    const briefOf = (name: string) =>
      readFileSync(
        join(run.dir, "roles", name, started.find((e) => e.name === name)?.dispatchId ?? "", "brief.md"),
        "utf8",
      );
    const brief = briefOf("T1");
    expect(brief).toContain("Write src/wallet.ts: a Wallet class with balance().");
    expect(brief).toContain("EXTRA: <path> — <why>");
    // the architect's first brief: its loop contract, the goal, the digest and the slots
    const first = briefOf("architect-1");
    expect(first).toContain("delegate_task");
    expect(first).toContain("The run's goal: wallet.");
    expect(first).toContain("the run started: wallet");
    expect(first).toMatch(/Writers running: \d of 4/);
    // the architect may change the repository (its profile access, spec D3)
    expect(readRecords(run).records.find((r) => r.role === "architect")?.access).toBe("workspace-write");
    const report = readFileSync(join(run.dir, "report.md"), "utf8");
    expect(report).toContain("Verdict: stopped — idle");
    expect(report).toContain("the wallet first");
    expect(readFileSync(join(run.dir, "ledger", "progress.md"), "utf8")).toStartWith("# Progress");
  });
});

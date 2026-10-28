import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../../src/domain/run-machine.ts";
import { renderBrief } from "../../src/services/run-briefs.ts";
import { addKnowledge } from "../../src/services/run-service.ts";
import type { Run } from "../../src/services/run-store.ts";
import { teamSend } from "../../src/services/team.ts";
import { snapshotEnv } from "../helpers.ts";
import { makeLog, startedFields } from "../domain/run-fixtures.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

type Dispatch = Extract<Action, { type: "dispatch" }>;
const task: Dispatch = {
  type: "dispatch",
  unit: "T1",
  name: "T1",
  role: "worker",
  lane: null,
  rung: "codex:gpt-6-sol#high",
  thread: null,
  failoverFrom: null,
  brief: "task",
  notes: [],
};

/** A run whose architect delegated T1 to a worker, with T1's brief file written. */
function delegated(run: Run) {
  mkdirSync(join(run.dir, "tasks", "T1"), { recursive: true });
  writeFileSync(join(run.dir, "tasks", "T1", "brief.md"), "Add the balance endpoint.\n");
  const log = makeLog();
  log.add("run.started", startedFields);
  log.add("task.delegated", {
    taskId: "T1",
    role: "worker",
    rung: "codex:gpt-6-sol#high",
    thread: null,
    ledgerTask: null,
    by: "architect-1",
    why: "next",
  });
  return log.state();
}

describe("a delegated task's brief (plan 48: the only briefs are a turn's and a task's)", () => {
  it("puts the repo's standing rules for the role at the end of part 3", async () => {
    const { run, repo } = freshRun();
    await addKnowledge(repo, "always A");
    await addKnowledge(repo, "[worker] only W");
    await addKnowledge(repo, "[reviewer] only R");
    const text = await renderBrief(run, delegated(run), task, false);
    const rules = text.indexOf("Standing rules for the worker role in this repo (its knowledge.md):");
    expect(rules).toBeGreaterThan(text.indexOf("<unit-context>"));
    expect(rules).toBeLessThan(text.indexOf("<this-round>"));
    expect(text).toContain("always A");
    expect(text).toContain("only W");
    expect(text).not.toContain("only R");
    expect(text).toContain("Add the balance endpoint.");
    expect(text).not.toContain("lanes/");
  });

  it("gives no rules block when the repo has none, and carries the team messages sent to the task", async () => {
    const { run } = freshRun();
    await teamSend({ run: run.id, from: "T2", to: "T1", text: "Operator is in src/b/settings.ts" });
    await teamSend({ run: run.id, from: "T2", to: "verifier", text: "for the verifier" });
    const text = await renderBrief(run, delegated(run), task, false);
    expect(text).not.toContain("Standing rules");
    expect(text).toContain(
      "Your team sent you these (catherd team read for the rest):\n- #1 T2 → T1: Operator is in src/b/settings.ts",
    );
    expect(text).not.toContain("for the verifier");
  });
});

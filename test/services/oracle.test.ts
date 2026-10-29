import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectTool } from "../../src/domain/role-tools.ts";
import type { RunRecord } from "../../src/domain/record.ts";
import { callArchitectTool } from "../../src/services/architect-tools.ts";
import { oracleChange } from "../../src/services/oracle.ts";
import { endedEvent } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRunTree } from "../../src/services/run-tree.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { commitInClone, snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

const deps = fakeDeps();
const call = (run: Run, tool: ArchitectTool, args: unknown) =>
  callArchitectTool({ deps, run, caller: { name: "architect-1", role: "architect" }, pollMs: 1 }, tool, args);

const PAY = 'it("keeps the currency", () => {});\n';

async function oracleRun(): Promise<{ run: Run; tree: string }> {
  const { run, origin } = branchRun();
  commitInClone(origin, "seed", { path: "test/pay.test.ts", text: PAY });
  const { tree } = await claimRunTree(deps, run);
  await appendEvent(run, { type: "run.started", ...startedFields });
  await call(run, "ledger", {
    tasks: {
      add: [
        { id: "L1", goal: "pay", oracle: ["test/pay.test.ts"] },
        { id: "L2", goal: "docs" },
      ],
    },
    why: "plan",
  });
  return { run, tree };
}

describe("the oracle rule's diff (plan 54, spec D9)", () => {
  it("diffs a writer's oracle edits against the tree it was delegated on, only for a ledger task with an oracle", async () => {
    const { run, tree } = await oracleRun();
    await call(run, "delegate_task", { role: "worker", task: "pay", ledgerTask: "L1", why: "w" });
    await call(run, "delegate_task", { role: "worker", task: "docs", ledgerTask: "L2", why: "w" });
    const arch = replayRun(run).arch;
    expect(arch.tasks.T1?.snapshot).toMatch(/^[0-9a-f]{40}$/);
    expect(arch.tasks.T2?.snapshot).toBeNull();
    writeFileSync(
      join(tree, "test", "pay.test.ts"),
      'it("keeps the currency", () => { expect(1).toBe(2); });\n',
    );
    writeFileSync(join(tree, "pay.ts"), "export const pay = 1;\n");
    const change = await oracleChange(run, "T1");
    expect(change).toEqual({ paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff" });
    expect(readFileSync(join(run.dir, "tasks", "T1", "oracle.diff"), "utf8")).toContain(
      '+it("keeps the currency", () => { expect(1).toBe(2); });',
    );
    expect(await oracleChange(run, "T2")).toBeNull();
    const record = {
      dispatchId: "d1",
      name: "T1",
      role: "worker",
      status: "ok",
      replyStatus: "complete",
      replyWhy: "done",
      thread: null,
      error: null,
      replyPath: "",
    } as unknown as RunRecord;
    expect(endedEvent(run, record, "T1", change)).toMatchObject({ oracle: change });
    expect(endedEvent(run, record, "T1")).not.toHaveProperty("oracle");
  });

  it("oracle_accept records the reason for a held change and refuses a task that holds none", async () => {
    const { run } = await oracleRun();
    await call(run, "delegate_task", { role: "worker", task: "pay", ledgerTask: "L1", why: "w" });
    await expect(call(run, "oracle_accept", { taskId: "T1", why: "x" })).rejects.toThrow(
      "T1 holds no oracle change",
    );
    await appendEvent(run, {
      type: "dispatch.started",
      dispatchId: "d1",
      name: "T1",
      role: "worker",
      unit: "T1",
      lane: null,
      rung: "codex:gpt-6-sol#high",
      thread: null,
    });
    await appendEvent(run, {
      type: "dispatch.ended",
      dispatchId: "d1",
      name: "T1",
      unit: "T1",
      status: "ok",
      replyStatus: "complete",
      reason: null,
      why: "ok",
      thread: null,
      head: null,
      environment: null,
      verdict: null,
      findings: [],
      replyPath: "roles/T1/d1/reply.md",
      oracle: { paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff" },
    });
    expect(await call(run, "oracle_accept", { taskId: "T1", why: "it asserted the old fee" })).toEqual({
      accepted: "T1",
    });
    expect(readEvents(run).at(-1)).toMatchObject({
      type: "oracle.accepted",
      taskId: "T1",
      by: "architect-1",
    });
    expect(replayRun(run).arch.tasks.T1?.oracle?.accepted).toBe("it asserted the old fee");
  });
});

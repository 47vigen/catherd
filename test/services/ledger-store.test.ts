import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/infra/db.ts";
import { ledgerProgress, ledgerTasks, renderLedger, writeLedger } from "../../src/services/ledger-store.ts";
import { freshRun } from "./helpers.ts";

const AT = new Date("2026-10-28T10:00:00.000Z");

describe("the ledger store (plan 47, spec D2 and D13)", () => {
  it("keeps tasks and progress as rows and renders them read-only into ledger/", () => {
    const { run } = freshRun();
    writeLedger(run, { tasks: { add: [{ id: "L1", goal: "the wallet" }] }, progress: "planned L1" }, AT);
    writeLedger(run, { tasks: { set: [{ id: "L1", state: "done" }] } }, AT);
    expect(ledgerTasks(run)).toEqual([
      { id: "L1", goal: "the wallet", state: "done", depends: [], oracle: [] },
    ]);
    expect(ledgerProgress(run)).toEqual([{ at: AT.toISOString(), text: "planned L1" }]);
    renderLedger(run, [
      { taskId: "T1", ledgerTask: "L1", rung: "codex:m#high", working: false, outcome: "ok/complete" },
    ]);
    const view = JSON.parse(readFileSync(join(run.dir, "ledger", "tasks.json"), "utf8"));
    expect(view).toEqual([
      {
        id: "L1",
        goal: "the wallet",
        state: "done",
        depends: [],
        oracle: [],
        assignee: null,
        attempts: [{ taskId: "T1", rung: "codex:m#high", outcome: "ok/complete" }],
        blocks: [],
      },
    ]);
    expect(readFileSync(join(run.dir, "ledger", "progress.md"), "utf8")).toContain("planned L1");
  });

  it("writes nothing when the patch does not apply", () => {
    const { run } = freshRun();
    writeLedger(run, { tasks: { add: [{ id: "L1", goal: "g" }] } }, AT);
    expect(() =>
      writeLedger(run, { tasks: { add: [{ id: "L2", goal: "g", depends: ["L9"] }] }, progress: "lost" }, AT),
    ).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(ledgerTasks(run).map((t) => t.id)).toEqual(["L1"]);
    expect(db().query("SELECT count(*) AS n FROM ledger_progress").get()).toEqual({ n: 0 });
  });
});

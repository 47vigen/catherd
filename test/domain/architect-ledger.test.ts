import { describe, expect, it } from "bun:test";
import {
  applyLedgerPatch,
  type LedgerTask,
  ledgerView,
  PROGRESS_SHOWN,
  renderProgress,
} from "../../src/domain/ledger.ts";

const task = (id: string, o: Partial<LedgerTask> = {}): LedgerTask => ({
  id,
  goal: `do ${id}`,
  state: "todo",
  depends: [],
  oracle: [],
  ...o,
});

describe("the architect's ledger (plan 47, spec D2)", () => {
  it("adds as todo, sets, removes, and keeps the order tasks were added in", () => {
    const out = applyLedgerPatch([task("L1"), task("L2")], {
      remove: ["L1"],
      add: [{ id: "L3", goal: "g3", depends: ["L2"], oracle: ["test/a.test.ts"] }],
      set: [{ id: "L2", state: "done", goal: "g2" }],
    });
    expect(out).toEqual([
      task("L2", { goal: "g2", state: "done" }),
      task("L3", { goal: "g3", depends: ["L2"], oracle: ["test/a.test.ts"] }),
    ]);
  });

  it("refuses a patch on an id it lacks, a duplicate add, and a dangling depends", () => {
    const err = expect.objectContaining({ code: "E_INPUT_INVALID" });
    expect(() => applyLedgerPatch([], { set: [{ id: "L9", state: "done" }] })).toThrow(err);
    expect(() => applyLedgerPatch([task("L1")], { add: [{ id: "L1", goal: "x" }] })).toThrow(err);
    expect(() => applyLedgerPatch([task("L1")], { remove: ["L9"] })).toThrow(err);
    expect(() =>
      applyLedgerPatch([task("L1", { depends: [] })], { set: [{ id: "L1", depends: ["L2"] }] }),
    ).toThrow(err);
  });

  it("derives running and review from the task's dispatches; the architect's done, blocked and impossible stand", () => {
    const tasks = [task("L1"), task("L2"), task("L3", { state: "impossible" }), task("L4")];
    const view = ledgerView(tasks, [
      { taskId: "T1", ledgerTask: "L1", rung: "codex:m#high", working: false, outcome: "failed/null" },
      { taskId: "T2", ledgerTask: "L1", rung: "codex:m#xhigh", working: true, outcome: null },
      { taskId: "T3", ledgerTask: "L2", rung: "codex:m#high", working: false, outcome: "ok/complete" },
      { taskId: "T4", ledgerTask: "L3", rung: "codex:m#high", working: true, outcome: null },
    ]);
    expect(view.map((v) => [v.id, v.state, v.assignee, v.attempts.length])).toEqual([
      ["L1", "running", "T2", 2],
      ["L2", "review", null, 1],
      ["L3", "impossible", "T4", 1],
      ["L4", "todo", null, 0],
    ]);
    expect(view[0]?.blocks).toEqual([]);
  });

  it("shows the last 40 progress entries and archives the rest", () => {
    const entries = Array.from({ length: PROGRESS_SHOWN + 2 }, (_, i) => ({
      at: `t${i}`,
      text: `step ${i}`,
    }));
    const { shown, archive } = renderProgress(entries);
    expect(shown).toContain("## t2\n\nstep 2\n");
    expect(shown).not.toContain("## t1\n");
    expect(archive).toContain("## t0\n\nstep 0\n");
    expect(archive).toContain("## t1\n");
    expect(archive).not.toContain("## t2\n");
  });
});

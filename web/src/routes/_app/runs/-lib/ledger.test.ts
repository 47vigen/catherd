import { ledgerSummary, ledgerTasks } from "./ledger";

const task = (id: string, state: "todo" | "running" | "review" | "done" | "blocked" | "impossible") => ({
  id,
  goal: `Goal ${id}`,
  state,
  depends: [],
  dispatchIds: [],
});

test("the summary reads the ledger's own states, in reading order, and its own count", () => {
  const tasks = [
    task("L1", "done"),
    task("L2", "todo"),
    task("L3", "running"),
    task("L4", "blocked"),
    task("L5", "done"),
  ];
  expect(ledgerSummary(tasks)).toBe("1 running · 1 blocked · 1 todo · 2 done of 5");
});

test("a state the ledger does not have yet is left out, and an empty ledger has nothing to say", () => {
  expect(ledgerSummary([task("L1", "todo"), task("L2", "todo")])).toBe("2 todo of 2");
  expect(ledgerSummary([])).toBeNull();
});

test("the count is named a ledger task on an architect run", () => {
  expect(ledgerTasks(1)).toBe("1 ledger task");
  expect(ledgerTasks(8)).toBe("8 ledger tasks");
  expect(ledgerTasks(0)).toBe("0 ledger tasks");
});

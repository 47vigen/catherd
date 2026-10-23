import { homeOf } from "./issues";

test("an issue belongs to the section that edits its field", () => {
  expect(homeOf("budget.usd")).toBe("budget");
  expect(homeOf("maxEffort.codex:gpt-6-sol")).toBe("effort");
  expect(homeOf("limits.memory.floorMb")).toBe("limits");
  expect(homeOf("lock.heavy")).toBe("limits");
  expect(homeOf("notify")).toBe("notifications");
  expect(homeOf("harness.codex")).toBe("isolation");
  expect(homeOf("failover.codex:a#high")).toBe("failover");
});

test("a role's issue goes to its row, and an access warning is collapsed", () => {
  expect(homeOf("roles.worker.rungs")).toBe("role:worker");
  expect(homeOf("roles.worker.access")).toBe("access");
  expect(homeOf("roles.judge.access")).toBe("access");
});

test("anything else is left for the top of the page", () => {
  expect(homeOf("profile")).toBe("other");
  expect(homeOf("catalog")).toBe("other");
});

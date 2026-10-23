import type { RunView } from "../../../../client";
import { daemonStatus, runStatus } from "./run-status";

const run = (over: Partial<RunView>): RunView => ({
  id: "r1",
  title: "t",
  repo: "/r",
  engine: "2.0",
  phase: "running",
  outcome: null,
  daemon: { alive: true, pid: 1, beatAgeSec: 1 },
  milestones: [],
  live: [],
  parked: [],
  holds: [],
  paused: null,
  last: null,
  startedAt: "2026-10-21T10:00:00Z",
  updatedAt: "2026-10-21T10:00:00Z",
  elapsedSec: 0,
  waitingSec: 0,
  countingSince: null,
  ...over,
});
const parked = {
  run: "r1",
  runTitle: "t",
  unit: "M1",
  question: "q",
  reason: "needs_user",
  at: "",
  command: "",
} as const;

test.each([
  ["a 1.5 run", { engine: "1.5", phase: null }, "info"],
  ["a done run", { phase: "ended", outcome: "done" }, "done"],
  ["a cancelled run", { phase: "ended", outcome: "cancelled" }, "cancelled"],
  ["a failed run", { phase: "ended", outcome: "failed" }, "failed"],
  ["a parked run", { parked: [parked] }, "parked"],
  ["a planning run", { phase: "planning" }, "planning"],
  ["a run awaiting approval", { phase: "approval" }, "approval"],
  ["a running run", { phase: "running" }, "running"],
] as const)("%s reads as %s", (_name, over, status) => {
  expect(runStatus(run(over as Partial<RunView>))).toBe(status);
});

test("the daemon reads alive or dead", () => {
  expect(daemonStatus(run({}))).toBe("alive");
  expect(daemonStatus(run({ daemon: { alive: false, pid: null, beatAgeSec: null } }))).toBe("dead");
});

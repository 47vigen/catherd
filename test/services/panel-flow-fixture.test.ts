import { afterEach, expect, test } from "bun:test";
import { flowOf } from "../../src/services/run-flow.ts";
import { readEvents } from "../../src/services/run-events-store.ts";
import { findRun, readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";
import { seedFlowRun } from "../panel-flow-fixture.ts";

afterEach(snapshotEnv());

const START = Date.parse("2026-10-01T10:00:00.000Z");
const at = (minute: number) => new Date(START + minute * 60_000).toISOString();
const minutes = (from: string, to: string | null) => (Date.parse(to ?? at(45)) - Date.parse(from)) / 60_000;

test("the seeded flow run covers the browser acceptance data", async () => {
  withHome();
  const repo = tempRepo();
  const { id } = await seedFlowRun(fakeDeps(), repo);
  const run = findRun(id);
  const flow = flowOf(run, readEvents(run), readRecords(run).records, Date.parse(at(45)));
  if (!flow) throw new Error("the seeded run must derive a flow");

  // 45 minutes of wall time, well past the 30 the acceptance needs.
  expect(flow.endedAt).not.toBeNull();
  expect(minutes(flow.startedAt, flow.endedAt)).toBeGreaterThanOrEqual(30);

  // Nine ledger tasks: the eight the first pass used, plus one long id for truncation, and several states.
  expect(flow.tasks.length).toBeGreaterThanOrEqual(8);
  expect(flow.tasks.slice(0, 8).map((t) => t.id)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  const long = flow.tasks.find((t) => t.id.startsWith("L9-"));
  expect(long?.id.length).toBeGreaterThan(20);
  expect(long?.goal.length).toBeGreaterThan(40);
  expect(long?.depends).toEqual(["L8"]);
  expect(new Set(flow.tasks.map((t) => t.state))).toEqual(new Set(["done", "review", "todo", "blocked"]));

  // Three checks, one failed with a new failure and one inherited failure.
  expect(flow.checks.map((c) => c.checkId)).toEqual(["C1", "C2", "C3"]);
  expect(flow.checks.find((c) => c.checkId === "C1")).toMatchObject({
    exit: 1,
    verdict: "new",
    failureCount: 2,
    newFailures: 1,
    inheritedFailures: 1,
  });
  expect(flow.checks.filter((c) => c.exit === 0)).toHaveLength(2);

  // A limit with a real hold, and the second one lands while no role works.
  expect(
    flow.dispatches
      .filter((d) => d.status === "limit")
      .map((d) => d.name)
      .sort(),
  ).toEqual(["T1", "T8"]);
  expect(flow.quotaHolds).toHaveLength(2);
  expect(flow.quotaHolds.find((h) => h.startedAt === at(24))).toMatchObject({ endedAt: at(28) });

  // Every idle reason is a positive interval in the derived model, not just an event in the file.
  const idle = (reason: string) =>
    flow.idle.filter((i) => i.reason === reason && minutes(i.startedAt, i.endedAt) > 0);
  for (const reason of ["owner", "quota", "check", "gap"]) expect(idle(reason).length).toBeGreaterThan(0);
  expect(idle("owner")[0]).toMatchObject({ startedAt: at(19), endedAt: at(22) });
  expect(idle("quota")[0]).toMatchObject({ startedAt: at(24), endedAt: at(25) });
  expect(idle("check").map((i) => [i.startedAt, i.endedAt])).toEqual([
    [at(28), at(29)],
    [at(32), at(36)],
    [at(37), at(39)],
    [at(40), at(41)],
  ]);
  expect(idle("gap").length).toBeGreaterThan(0);
});

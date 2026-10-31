import type { RunView } from "../../../../client";
import { at, dispatch, flowFixture } from "./flow.fixture";
import { costSplit, findings, spends, timeSplit } from "./insights";

const run = { phase: "ended", outcome: "done" } as RunView;
const end = Date.parse(at(120));

test("the time split takes idle by reason and counts the rest as working", () => {
  const { wallMs, parts } = timeSplit(flowFixture(), end);
  expect(wallMs).toBe(120_000);
  expect(parts).toEqual([
    { key: "working", ms: 60_000 },
    { key: "gap", ms: 60_000 },
  ]);
});

test("the cost split groups by role family and ranks the role runs", () => {
  const flow = flowFixture();
  flow.dispatches[0] = dispatch({ costUsd: 6 });
  const { unit, total, families, top } = costSplit(spends(flow, [], end));
  expect(unit).toBe("cost");
  expect(total).toBe(10);
  expect(families[0]).toEqual({ family: "build", value: 8 });
  expect(top[0]!.spend.dispatch.name).toBe("T1");
});

test("an ordinary run says nothing stands out", () => {
  const flow = flowFixture();
  flow.checks = [];
  flow.idle = [];
  flow.dispatches = flow.dispatches.map((d) => ({ ...d, status: "ok" as const, climbFrom: null, costUsd: 1 }));
  flow.dispatches.push(dispatch({ dispatchId: "D9", name: "T9", costUsd: 1 }));
  expect(findings(run, flow, [], end)).toEqual([]);
});

test("findings name the failing last check first, then what did not finish, limits and idle", () => {
  const ids = findings(run, flowFixture(), [], end).map((f) => [f.id, f.tone]);
  expect(ids).toEqual([
    ["check-C1", "danger"],
    ["bad", "warning"],
    ["limits", "warning"],
    ["idle", "warning"],
  ]);
  expect(findings(run, flowFixture(), [], end)[0]!.title).toBe("The run ended done, but its last full check failed");
});

test("a later passing check of the same scope clears the failure", () => {
  const flow = flowFixture();
  flow.checks.push({ ...flow.checks[0]!, checkId: "C2", exit: 0, verdict: "pass", startedAt: at(60), endedAt: at(70) });
  expect(findings(run, flow, [], end).some((f) => f.id.startsWith("check-"))).toBe(false);
});

test("one role run that takes most of the cost is named with its share", () => {
  const flow = flowFixture();
  flow.dispatches[0] = dispatch({ costUsd: 30 });
  const spend = findings(run, flow, [], end).find((f) => f.id === "spend");
  expect(spend?.title).toBe("T1 took 88% of the cost");
  expect(spend?.selection).toEqual({ nodeId: "task/T1", attemptId: "D1" });
});

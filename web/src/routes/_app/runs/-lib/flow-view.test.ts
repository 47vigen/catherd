import type { RunModel } from "../../../../client";
import { drawerModel, flowGeometry, stackIntervals } from "./flow-view";
import { at, flowFixture } from "./flow.fixture";

test("open geometry grows, closed runs freeze and overlap gets separate tracks", () => {
  const flow = { ...flowFixture(), endedAt: null };
  const a = flowGeometry(flow, Date.parse(at(130)));
  const b = flowGeometry(flow, Date.parse(at(140)));
  expect(b.interval(at(10), null).width).toBeGreaterThan(a.interval(at(10), null).width);
  expect(b.interval(at(10), at(30))).toEqual(a.interval(at(10), at(30)));
  expect(flowGeometry(flowFixture(), Date.parse(at(900))).end).toBe(Date.parse(at(120)));
  expect(a.width).toBeGreaterThanOrEqual(960);
  expect(a.interval(at(10), at(10)).width).toBe(2);
  expect(
    stackIntervals([
      { x: 0, width: 20 },
      { x: 10, width: 20 },
      { x: 40, width: 2 },
    ]),
  ).toEqual([0, 1, 0]);
});
test("drawer projections retain existing nodes and supply record-only and requested targets", () => {
  const flow = flowFixture();
  flow.checks[0] = { ...flow.checks[0]!, startedAt: null, selection: { nodeId: "check/C1", attemptId: null } };
  const model: RunModel = {
    run: "r1",
    engine: "2.0",
    seq: 1,
    phase: "running",
    outcome: null,
    flow,
    nodes: [],
    edges: [],
    dispatches: [],
  };
  const projected = drawerModel(model);
  expect(projected.nodes.find((n) => n.id === "task/orphan")?.attempts[0]?.dispatchId).toBe("DU");
  expect(projected.nodes.find((n) => n.id === "check/C1")?.attempts).toEqual([]);
  expect(model.nodes).toEqual([]);
  expect(drawerModel(projected).nodes).toEqual(projected.nodes);
});

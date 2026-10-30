import type { RunModel } from "../../../../client";
import { drawerModel, flowGeometry, mergeIdle, tickStep } from "./flow-view";
import { at, flowFixture } from "./flow.fixture";

test("geometry fits narrow and wide viewports, scales manually, and chooses round ticks", () => {
  const flow = { ...flowFixture(), endedAt: null };
  for (const width of [200, 1000]) {
    const fitted = flowGeometry(flow, Date.parse(at(130)), width);
    expect(fitted.width).toBe(width);
    expect(fitted.nowX).toBeCloseTo(width - 16);
    expect(flowGeometry(flow, Date.parse(at(140)), width, fitted.pixelsPerMs).width).toBeGreaterThan(width);
  }
  expect(flowGeometry(flowFixture(), Date.parse(at(900))).end).toBe(Date.parse(at(120)));
  expect(tickStep(1800, 600)).toBe(300);
  expect(tickStep(1800, 200)).toBe(900);
  const idle: NonNullable<RunModel["flow"]>["idle"] = [
    { startedAt: at(0), endedAt: at(10), reason: "gap", evidenceSeqs: [1] },
    { startedAt: at(10), endedAt: at(20), reason: "gap", evidenceSeqs: [2, 3] },
  ];
  const original = structuredClone(idle);
  expect(mergeIdle(idle)).toEqual([{ ...original[0], endedAt: at(20) }]);
  expect(idle).toEqual(original);
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

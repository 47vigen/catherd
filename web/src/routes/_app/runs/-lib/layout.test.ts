import type { RunModel } from "../../../../client";
import { CASE_HELPERS } from "./case-helpers.fixture";
import { layoutKey, layoutRunModel } from "./layout";

test("every edge runs left to right", async () => {
  const { nodes, edges } = await layoutRunModel(CASE_HELPERS);
  expect(nodes).toHaveLength(CASE_HELPERS.nodes.length);
  expect(edges).toHaveLength(CASE_HELPERS.edges.length);
  const x = new Map(nodes.map((n) => [n.id, n.position.x]));
  for (const e of edges) expect(x.get(e.target)!, `${e.source} > ${e.target}`).toBeGreaterThan(x.get(e.source)!);
});

test("a status change keeps the layout key; a new node changes it", () => {
  const running: RunModel = {
    ...CASE_HELPERS,
    nodes: CASE_HELPERS.nodes.map((n) => (n.id === "judge" ? { ...n, status: "running", now: "Judging" } : n)),
  };
  expect(layoutKey(running)).toBe(layoutKey(CASE_HELPERS));
  const more: RunModel = {
    ...CASE_HELPERS,
    nodes: [...CASE_HELPERS.nodes, { ...CASE_HELPERS.nodes[0]!, id: "M2/route" }],
  };
  expect(layoutKey(more)).not.toBe(layoutKey(CASE_HELPERS));
});

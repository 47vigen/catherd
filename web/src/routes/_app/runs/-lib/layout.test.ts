import type { RunModel, RunNode } from "../../../../client";
import { CASE_HELPERS } from "./case-helpers.fixture";
import { absolutePosition, groupId, layoutKey, layoutRunModel } from "./layout";

const step = (id: string, kind: RunNode["kind"], milestone: string | null, role: RunNode["role"] = null): RunNode => ({
  ...CASE_HELPERS.nodes[0]!,
  id,
  kind,
  milestone,
  role,
  title: id,
});

/** Two milestones after M1 run side by side; M2 has two lanes, the second after the first's check. */
const WIDE: RunModel = {
  ...CASE_HELPERS,
  nodes: [
    step("start", "start", null),
    step("M1/route", "route", "M1"),
    step("M1/land", "land", "M1"),
    step("M2/route", "route", "M2"),
    step("M2/lane/a", "lane", "M2", "worker"),
    step("M2/check/a", "check", "M2"),
    step("M2/lane/b", "lane", "M2", "worker"),
    step("M2/check/b", "check", "M2"),
    step("M2/lane/c", "lane", "M2", "worker"),
    step("M2/land", "land", "M2"),
    step("M3/route", "route", "M3"),
    step("M3/land", "land", "M3"),
    step("end", "end", null),
  ],
  edges: [
    ["start", "M1/route"],
    ["M1/route", "M1/land"],
    ["M1/land", "M2/route"],
    ["M1/land", "M3/route"],
    ["M2/route", "M2/lane/a"],
    ["M2/route", "M2/lane/b"],
    ["M2/lane/a", "M2/check/a"],
    ["M2/lane/b", "M2/check/b"],
    ["M2/check/a", "M2/lane/c"],
    ["M2/lane/c", "M2/land"],
    ["M2/check/b", "M2/land"],
    ["M2/land", "end"],
    ["M3/route", "M3/land"],
    ["M3/land", "end"],
  ].map(([from, to]) => ({ from: from!, to: to! })),
};

test("every edge runs left to right, and each milestone is a box around its steps", async () => {
  const { nodes, edges } = await layoutRunModel(CASE_HELPERS);
  expect(nodes.filter((n) => n.type !== "milestone")).toHaveLength(CASE_HELPERS.nodes.length);
  expect(nodes.filter((n) => n.type === "milestone").map((n) => n.id)).toEqual([groupId("M1")]);
  expect(edges).toHaveLength(CASE_HELPERS.edges.length);
  const x = (id: string) => absolutePosition(nodes, id)!.x;
  for (const e of edges) expect(x(e.target), `${e.source} > ${e.target}`).toBeGreaterThan(x(e.source));
  for (const n of nodes.filter((n) => n.id.startsWith("M1/"))) expect(n.parentId).toBe(groupId("M1"));
  expect(nodes.find((n) => n.id === "start")!.type).toBe("pill");
  // a box comes before the steps in it, as React Flow needs
  expect(nodes.findIndex((n) => n.id === groupId("M1"))).toBeLessThan(nodes.findIndex((n) => n.id === "M1/route"));
});

test("lanes that start together share a column in plan order; milestones side by side share one too", async () => {
  const { nodes } = await layoutRunModel(WIDE);
  const at = (id: string) => absolutePosition(nodes, id)!;
  expect(at("M2/lane/a").x).toBe(at("M2/lane/b").x);
  expect(at("M2/lane/a").y).toBeLessThan(at("M2/lane/b").y);
  expect(at("M2/lane/c").x).toBeGreaterThan(at("M2/check/a").x);
  expect(at(groupId("M2")).x).toBe(at(groupId("M3")).x);
  expect(at(groupId("M2")).y).toBeLessThan(at(groupId("M3")).y);
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

import { CASE_HELPERS as model } from "./case-helpers.fixture";
import { commitsFor } from "./changes";

const node = (id: string) => model.nodes.find((n) => n.id === id)!;

test("a commit node lists every round, a lane the commit of the round it shows", () => {
  expect(commitsFor(model, node("M1/commit"), undefined).map((c) => c.label)).toEqual(["round 1", "round 0"]);
  expect(commitsFor(model, node("M1/land"), undefined)).toHaveLength(2);
  const lane = node("M1/lane/M1.L1");
  expect(commitsFor(model, lane, lane.attempts[1]).map((c) => c.sha.slice(0, 7))).toEqual(["fe528ac"]);
  expect(commitsFor(model, lane, lane.attempts[0]).map((c) => c.sha.slice(0, 7))).toEqual(["7c024b3"]);
});

test("a step that produces no commit has none", () => {
  expect(commitsFor(model, node("judge"), undefined)).toEqual([]);
  expect(commitsFor(model, node("M1/check/M1.L1"), undefined)).toEqual([]);
});

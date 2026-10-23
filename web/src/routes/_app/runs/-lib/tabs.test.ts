import { CASE_HELPERS as model } from "./case-helpers.fixture";
import { tabsFor } from "./tabs";

const node = (id: string) => model.nodes.find((n) => n.id === id)!;

test("each step gets the tabs that mean something for it", () => {
  expect(tabsFor(node("M1/lane/M1.L1"))).toEqual(["overview", "prompt", "log", "output", "changes"]);
  expect(tabsFor(node("M1/check/M1.L1"))).toEqual(["overview", "checks"]);
  expect(tabsFor(node("M1/commit"))).toEqual(["overview", "changes"]);
  expect(tabsFor(node("M1/review"))).toEqual(["overview", "prompt", "log", "output"]);
  expect(tabsFor(node("start"))).toEqual(["overview"]);
});

import { TIMELINE_FILTERS } from "./timeline-filters";

test("the checks filter names the events a check writes, and no filter lists a deleted event", () => {
  const types = (id: string) => TIMELINE_FILTERS.find((f) => f.id === id)?.types;
  expect(types("checks")).toBe("check.requested,check.done");
  expect(TIMELINE_FILTERS.map((f) => f.id)).not.toContain("commits");
  expect(TIMELINE_FILTERS.map((f) => f.types).join(",")).not.toMatch(/check\.ran|commit\.|milestone\./);
});

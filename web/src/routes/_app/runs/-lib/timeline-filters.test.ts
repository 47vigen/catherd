import { TIMELINE_FILTERS } from "./timeline-filters";

test("commits and landing include a failed auto-merge next to the merge", () => {
  const types = TIMELINE_FILTERS.find((f) => f.id === "commits")!.types.split(",");
  expect(types).toEqual(expect.arrayContaining(["milestone.merged", "merge.failed"]));
});

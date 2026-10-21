import { expect, it } from "bun:test";
import { onlyAllowedHits } from "../src/domain/lane.ts";
import { FINDING } from "../src/services/milestones.ts";

it("reads a finding line that says none as no finding (scorecard acceptance)", () => {
  for (const line of ["BLOCKER: none", "BUG: n/a", "- NIT: -", "BLOCKER: None"])
    expect(FINDING.exec(line)).toBeNull();
  expect(FINDING.exec("BUG: the parser drops a field")?.[1]).toBe("BUG");
});

it("matches a ./path hit against its Allow: entry (scorecard acceptance)", () => {
  expect(onlyAllowedHits(["./docs/a.md:3:x"], ["docs/a.md"])).toBe(true);
  expect(onlyAllowedHits(["./docs/b.md:3:x"], ["docs/a.md"])).toBe(false);
});

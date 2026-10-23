import { CASE_HELPERS } from "./case-helpers.fixture";
import { formatCost, formatTokens, totalsOf } from "./format";

test("a run's totals sum its dispatches; a run without a cost says so", () => {
  const t = totalsOf(CASE_HELPERS.dispatches);
  expect(t.tokens).toBeGreaterThan(10_000);
  expect(totalsOf([])).toEqual({ tokens: 0, costUsd: null, unpriced: 0 });
  expect(
    totalsOf([
      { ...CASE_HELPERS.dispatches[0]!, costUsd: 0.5 },
      { ...CASE_HELPERS.dispatches[0]!, costUsd: 0.25 },
    ]).costUsd,
  ).toBe(0.75);
});

test("tokens and cost read short", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(1_338_336)).toBe("1.3M");
  expect(formatCost(0.687)).toBe("$0.69");
});

test("formatCost(null) is a dash", () => {
  expect(formatCost(null)).toBe("—");
});

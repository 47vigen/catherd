import type { IndexedPair } from "../../../../client";
import { filterPairs, pairLine } from "./rungs";

const pair = (over: Partial<IndexedPair>): IndexedPair => ({
  rung: "codex:gpt-6-sol#high",
  intelligence: 42.04,
  price: { input: 1.25, output: 10 },
  speed: 80,
  context: null,
  cost: { tier: 0, value: 0, mode: "chatgpt-plan" },
  evidence: null,
  ...over,
});

test("filters pairs by rung text and describes each with what it has", () => {
  const a = pair({});
  const b = pair({ rung: "opencode:kimi-k3#max" });
  expect(filterPairs([a, b], "KIMI")).toEqual([b]);
  expect(filterPairs([a, b], "")).toEqual([a, b]);
  expect(pairLine(a)).toBe("intelligence 42.0 · $1.25/$10 per M · 80 tok/s · plan");
  expect(pairLine(pair({ price: null, speed: null, cost: { tier: 1, value: 1, mode: "metered" } }))).toBe(
    "intelligence 42.0",
  );
});

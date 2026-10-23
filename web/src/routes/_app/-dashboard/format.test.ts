import type { Overview, RunCard } from "../../../client";
import {
  dailyRows,
  formatCost,
  formatCount,
  formatElapsed,
  formatMinutes,
  formatSecs,
  rangeOf,
  repoName,
  runStatus,
} from "./format";

test("a range covers whole UTC days ending today", () => {
  const { from, to } = rangeOf(7, "2026-10-23");
  expect(to).toBe("2026-10-23T23:59:59.999Z");
  expect(from).toBe("2026-10-17T00:00:00.000Z");
  expect(Date.parse(to) + 1 - Date.parse(rangeOf(30, "2026-10-23").from)).toBe(30 * 86_400_000);
});

test("elapsed time reads as seconds, minutes, hours or days", () => {
  expect(formatElapsed(-5000)).toBe("0s");
  expect(formatElapsed(45_000)).toBe("45s");
  expect(formatElapsed(12 * 60_000 + 4000)).toBe("12m 04s");
  expect(formatElapsed(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
  expect(formatElapsed(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
});

test("numbers are compact and money has cents", () => {
  expect(formatCount(812)).toBe("812");
  expect(formatCount(34_200)).toBe("34k");
  expect(formatCount(1_240_000)).toBe("1.2M");
  expect(formatCost(0)).toBe("$0.00");
  expect(formatCost(12.4)).toBe("$12.40");
  expect(formatCost(1234.5)).toBe("$1,234.50");
});

test("minutes and seconds of work", () => {
  expect(formatMinutes(null)).toBe("–");
  expect(formatMinutes(0.4)).toBe("<1 min");
  expect(formatMinutes(42)).toBe("42 min");
  expect(formatMinutes(95)).toBe("1.6 h");
  expect(formatSecs(40)).toBe("40s");
  expect(formatSecs(12 * 60)).toBe("12m");
  expect(formatSecs(80 * 60)).toBe("1h 20m");
});

test("a repo shows by its folder name", () => {
  expect(repoName("/home/user/code/my repo/")).toBe("my repo");
  expect(repoName("")).toBe("");
});

test("a run's status: a 1.5 run is informational, an outcome ends it, a question parks it", () => {
  const card = (over: Partial<RunCard>) =>
    ({ engine: "2.0", outcome: null, openQuestions: 0, phase: "running", ...over }) as RunCard;
  expect(runStatus(card({ engine: "1.5" }))).toBe("info");
  expect(runStatus(card({ outcome: "failed" }))).toBe("failed");
  expect(runStatus(card({ openQuestions: 1 }))).toBe("parked");
  expect(runStatus(card({ phase: "approval" }))).toBe("approval");
  expect(runStatus(card({}))).toBe("running");
});

test("daily rows merge backends by name and pick cost or tokens", () => {
  const daily: Overview["daily"] = [
    {
      day: "2026-10-22",
      backends: [
        { backend: "opencode", tokens: 10, costUsd: 1 },
        { backend: "opencode-go", tokens: 5, costUsd: 2 },
      ],
    },
    { day: "2026-10-23", backends: [] },
  ];
  const cost = dailyRows(daily, "cost", 7);
  expect(cost.keys).toEqual(["opencode"]);
  expect(cost.rows).toEqual([
    { label: "Thu", parts: [{ key: "opencode", value: 3 }] },
    { label: "Fri", parts: [] },
  ]);
  expect(dailyRows(daily, "tokens", 7).rows[0]!.parts).toEqual([{ key: "opencode", value: 15 }]);
  expect(dailyRows(daily, "tokens", 30).rows[0]!.label).toBe("Oct 22");
});

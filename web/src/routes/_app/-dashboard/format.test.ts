import type { Overview, RunCard } from "../../../client";
import {
  backendTone,
  dailyRows,
  dailyTotals,
  formatCost,
  formatCount,
  formatElapsed,
  formatMinutes,
  formatSecs,
  modelName,
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
  expect(runStatus(card({ openQuestions: 1, paused: "2026-10-23T10:00:00Z" }))).toBe("paused");
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
    { day: "Thu, Oct 22", label: "Thu", total: 3, values: { opencode: 3 } },
    { day: "Fri, Oct 23", label: "Fri", total: 0, values: {} },
  ]);
  expect(dailyRows(daily, "tokens", 7).rows[0]!.values).toEqual({ opencode: 15 });
  expect(dailyRows(daily, "tokens", 30).rows[0]!.label).toBe("Oct 22");
  expect(dailyTotals(daily, "tokens")).toEqual([15, 0]);
});

test("a model reads the way people say it", () => {
  expect(modelName("codex:gpt-6-luna#high")).toBe("GPT-6 Luna");
  expect(modelName("claude-code:claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(modelName("claude:claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
  expect(modelName("codex:gpt-6.1-mini")).toBe("GPT-6.1 Mini");
  expect(modelName("opencode-go:moonshot/kimi-k2")).toBe("Kimi K2");
  expect(modelName("other")).toBe("Other");
});

test("a backend keeps one colour everywhere", () => {
  expect(backendTone("codex:gpt-6-sol").fill).toBe(backendTone("Codex").fill);
  expect(backendTone("claude-code").bg).toBe(backendTone("claude").bg);
  expect(backendTone("Claude Code").fill).toBe("var(--brand-anthropic)");
  expect(backendTone("codex").bg).not.toBe(backendTone("claude-code").bg);
});

test("unknown dashboard cost is a dash", () => {
  expect(formatCost(null)).toBe("—");
});

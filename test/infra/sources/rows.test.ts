import { describe, expect, it } from "bun:test";
import { isoDay, keepHighest, num, urlOr } from "../../../src/infra/sources/rows.ts";

describe("parser helpers (spec 1.2 §3.3)", () => {
  it("reads numbers and numeric strings, nothing else", () => {
    expect([num(1.5), num("0.25"), num(""), num("x"), num(null), num(Number.NaN)]).toEqual([
      1.5,
      0.25,
      null,
      null,
      null,
      null,
    ]);
  });

  it("keeps an http(s) URL and falls back on anything else", () => {
    expect(urlOr(" https://a.example/x ", "https://b.example")).toBe("https://a.example/x");
    expect(urlOr("Terminal-Bench v2 Leaderboard", "https://b.example")).toBe("https://b.example");
    expect(urlOr(undefined, "https://b.example")).toBe("https://b.example");
    expect(isoDay("2026-09-28T10:00:00.000Z")).toBe("2026-09-28");
  });

  it("keeps the highest value per rung and field", () => {
    const row = (rung: string, value: number) => ({
      rung,
      field: "f",
      value,
      date: "2026-09-28",
      url: "https://a",
    });
    expect(
      keepHighest([row("a", 1), row("a", 3), row("b", 2), row("a", 2)]).map((r) => [r.rung, r.value]),
    ).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });
});

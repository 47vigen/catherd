import { pageCount, parseEnum, parseListSearch } from "./list-search";

test("parseListSearch clamps and defaults", () => {
  expect(parseListSearch({})).toEqual({ page: 1, pageSize: 25, q: "" });
  expect(parseListSearch({ page: "3", pageSize: "50", q: " fast " })).toEqual({ page: 3, pageSize: 50, q: "fast" });
  expect(parseListSearch({ page: 2, pageSize: 100 })).toEqual({ page: 2, pageSize: 100, q: "" });
  expect(parseListSearch({ page: "-1", pageSize: "7" })).toEqual({ page: 1, pageSize: 25, q: "" });
  expect(parseListSearch({ page: "x" }).page).toBe(1);
  expect(parseListSearch({ page: "2.5" }).page).toBe(1);
  expect(parseListSearch({ q: 42 }).q).toBe("");
});

test("parseEnum", () => {
  expect(parseEnum("speech", ["api_key", "speech"] as const)).toBe("speech");
  expect(parseEnum("nope", ["api_key"] as const)).toBeUndefined();
  expect(parseEnum(1, ["api_key"] as const)).toBeUndefined();
});

test("pageCount", () => {
  expect(pageCount(0, 25)).toBe(1);
  expect(pageCount(25, 25)).toBe(1);
  expect(pageCount(26, 25)).toBe(2);
  expect(pageCount(120, 25)).toBe(5);
});

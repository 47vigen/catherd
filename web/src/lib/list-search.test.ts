import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { pageCount, parseEnum, parseListSearch, stripListDefaults } from "./list-search";

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

describe("stripListDefaults", () => {
  const app = () => {
    const root = createRootRoute();
    const list = (path: string) =>
      createRoute({
        getParentRoute: () => root,
        path,
        validateSearch: parseListSearch,
        search: { middlewares: [stripListDefaults] },
      });
    return createRouter({
      routeTree: root.addChildren([list("/runs"), list("/runs/$runId"), list("/questions")]),
      history: createMemoryHistory({ initialEntries: ["/runs"] }),
    });
  };

  test("a plain link never gains the defaults", async () => {
    const router = app();
    await router.load();
    await router.navigate({ href: "/questions" });
    expect(router.state.location.href).toBe("/questions");
  });

  test("defaults passed explicitly are dropped and other values stay", async () => {
    const router = app();
    await router.navigate({ href: "/runs?q=wallet&page=2" });
    expect(router.state.location.search).toEqual({ q: "wallet", page: 2 });
    await router.navigate({ href: "/runs/r1?page=1&pageSize=25&q=" });
    expect(router.state.location.href).toBe("/runs/r1");
  });
});

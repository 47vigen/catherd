import { parseAmount, patchFor } from "./patch";

test("a cleared budget field deletes it", () => {
  expect(patchFor("budget", { minutes: 30, tokens: null, usd: 5 })).toEqual({
    budget: { minutes: 30, tokens: null, usd: 5 },
  });
});

test("removed failover pairs are null", () => {
  const previous = {
    "codex:a#high": "codex:b#high",
    "codex:c#high": "codex:d#high",
  };
  expect(
    patchFor("failover", {
      pairs: { "codex:c#high": "codex:e#high" },
      previous,
    }),
  ).toEqual({
    failover: { "codex:a#high": null, "codex:c#high": "codex:e#high" },
  });
});

test("max effort removes a model the same way", () => {
  expect(
    patchFor("effort", {
      efforts: { "codex:a": "high" },
      previous: { "codex:a": "low", "codex:b": "max" },
    }),
  ).toEqual({ maxEffort: { "codex:a": "high", "codex:b": null } });
});

test("a role keeps its rungs in the order given and sends only the fields it was given", () => {
  expect(
    patchFor("roles", {
      role: "worker",
      rungs: ["codex:b#high", "codex:a#high"],
    }),
  ).toEqual({
    roles: { worker: { rungs: ["codex:b#high", "codex:a#high"] } },
  });
  expect(
    patchFor("roles", {
      role: "worker",
      timeouts: { idleMin: null, wallMin: null },
    }),
  ).toEqual({
    roles: { worker: { timeouts: null } },
  });
  expect(patchFor("roles", { role: "worker", enabled: false, access: "read-only" })).toEqual({
    roles: { worker: { enabled: false, access: "read-only" } },
  });
});

test("heavy lock and memory limits go to their own keys", () => {
  expect(
    patchFor("limits", {
      heavy: "cpus/2",
      reserveMb: 2048,
      perMilestoneMb: null,
      floorMb: 512,
    }),
  ).toEqual({
    lock: { heavy: "cpus/2" },
    limits: { memory: { reserveMb: 2048, perMilestoneMb: null, floorMb: 512 } },
  });
});

test("the other sections map one to one", () => {
  expect(patchFor("objective", { objective: "speed" })).toEqual({
    objective: "speed",
  });
  expect(patchFor("timeouts", { idleMin: 10, wallMin: 60 })).toEqual({
    timeouts: { idleMin: 10, wallMin: 60 },
  });
  expect(patchFor("bars", { copy: 10, build: 40, logic: 60, hard: 70 })).toEqual({
    bars: { copy: 10, build: 40, logic: 60, hard: 70 },
  });
  expect(patchFor("preflight", { confirm: true })).toEqual({
    preflight: { confirm: true },
  });
  expect(patchFor("notifications", { notify: ["finish"] })).toEqual({
    notify: ["finish"],
  });
  expect(patchFor("jev", { use: "off" })).toEqual({ jev: { use: "off" } });
  expect(patchFor("billing", { codex: "metered" })).toEqual({
    billing: { codex: "metered" },
  });
  expect(patchFor("isolation", { codex: true })).toEqual({
    harness: { codex: { isolated: true } },
  });
});

test("the land section patches land.autoMerge", () => {
  expect(patchFor("land", { autoMerge: true })).toEqual({
    land: { autoMerge: true },
  });
});

test("an amount is empty, a positive number, or invalid", () => {
  expect(parseAmount("")).toBeNull();
  expect(parseAmount(" 12.5 ")).toBe(12.5);
  expect(parseAmount("0")).toBeUndefined();
  expect(parseAmount("-3")).toBeUndefined();
  expect(parseAmount("abc")).toBeUndefined();
});

test("a section sends only the keys the user changed", () => {
  expect(
    patchFor("bars", { copy: 20, build: 50, logic: 60, hard: 65 }, { copy: 20, build: 45, logic: 60, hard: 65 }),
  ).toEqual({ bars: { build: 50 } });
  expect(
    patchFor(
      "limits",
      { heavy: "cpus/2", reserveMb: 4096, perMilestoneMb: null, floorMb: 512 },
      { heavy: "cpus/2", reserveMb: 2048, perMilestoneMb: null, floorMb: 512 },
    ),
  ).toEqual({ limits: { memory: { reserveMb: 4096 } } });
  expect(
    patchFor(
      "failover",
      { pairs: { a: "b" }, previous: { a: "b", c: "d" } },
      { pairs: { a: "b", c: "d" }, previous: { a: "b", c: "d" } },
    ),
  ).toEqual({ failover: { c: null } });
  expect(patchFor("budget", { minutes: null, tokens: null, usd: 8 }, { minutes: null, tokens: null, usd: 5 })).toEqual({
    budget: { usd: 8 },
  });
  expect(patchFor("bars", { copy: 20 }, { copy: 20 })).toEqual({});
});

test("section changes compare arrays whole and preserve changed nested values", () => {
  expect(patchFor("notifications", { notify: ["finish"] }, { notify: ["finish"] })).toEqual({});
  expect(patchFor("notifications", { notify: [] }, { notify: ["finish"] })).toEqual({ notify: [] });
  expect(patchFor("isolation", { codex: false, opencode: true }, { codex: true, opencode: true })).toEqual({
    harness: { codex: { isolated: false } },
  });
  expect(
    patchFor(
      "effort",
      { efforts: { a: "high" }, previous: { a: "low", b: "max" } },
      { efforts: { a: "low", b: "max" }, previous: { a: "low", b: "max" } },
    ),
  ).toEqual({ maxEffort: { a: "high", b: null } });
});

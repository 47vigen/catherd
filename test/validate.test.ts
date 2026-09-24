import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultProfile, patchProfile, validateProfile } from "../src/profile/profile.ts";
import { loadCatalog } from "../src/routing/catalog.ts";
import { withHome } from "./helpers.ts";

const saved = { ...process.env };
beforeEach(() => withHome());
afterEach(() => {
  process.env = { ...saved };
});

const withRoles = (roles: Parameters<typeof patchProfile>[1]["roles"]) =>
  patchProfile(defaultProfile(), { roles });

describe("validateProfile", () => {
  test("passes the default profile", () => {
    expect(validateProfile(defaultProfile(), loadCatalog())).toEqual([]);
  });

  test("keeps the worker on", () => {
    expect(validateProfile(withRoles({ worker: { enabled: false } }), loadCatalog())).toContain(
      "worker: cannot be disabled",
    );
  });

  test("names a model the catalog does not have", () => {
    expect(
      validateProfile(withRoles({ reviewer: { models: { "gpt-5-old": ["high"] } } }), loadCatalog()),
    ).toEqual(["reviewer: gpt-5-old is not in the catalog", "reviewer: no usable model is enabled"]);
  });

  test("refuses a model that cannot fill the role", () => {
    expect(
      validateProfile(withRoles({ artist: { models: { "claude-opus-5-5": ["low"] } } }), loadCatalog()),
    ).toEqual([
      "artist: claude-opus-5-5 cannot fill this role (it needs imageOut)",
      "artist: no usable model is enabled",
    ]);
  });

  test("refuses an effort the model does not offer", () => {
    expect(
      validateProfile(withRoles({ reviewer: { models: { "gpt-6-sol": ["high", "max"] } } }), loadCatalog()),
    ).toEqual(['reviewer: gpt-6-sol has no effort "max" (it has low, medium, high, xhigh)']);
  });

  test("refuses an unscored entry until it has a treat-like", () => {
    const p = withRoles({ writer: { models: { "gpt-6-luna": ["medium"] } } });
    const c = loadCatalog();
    expect(validateProfile(p, c)).toEqual([
      'writer: gpt-6-luna#medium is unscored; declare it "treat like" a scored entry in catalog.override.json',
      "writer: no usable model is enabled",
    ]);
    c.treatLike["gpt-6-luna#medium"] = "gpt-6-luna#high";
    expect(validateProfile(p, c)).toEqual([]);
  });

  test("checks that defaultRung is one of the role's entries", () => {
    expect(validateProfile(withRoles({ worker: { defaultRung: "gpt-6-sol#low" } }), loadCatalog())).toEqual([
      "worker: defaultRung gpt-6-sol#low is not one of its enabled entries",
    ]);
  });

  test("needs a worker ladder for every kind and difficulty", () => {
    const c = loadCatalog();
    c.bars.terminal.hard = { terminal: 99 };
    expect(validateProfile(defaultProfile(), c)).toEqual([
      "worker: no enabled entry clears the terminal/hard bar",
    ]);
  });

  test("does not check a disabled role", () => {
    expect(
      validateProfile(withRoles({ writer: { enabled: false, models: { nope: ["x"] } } }), loadCatalog()),
    ).toEqual([]);
  });

  test("passes a failover target on another, scored backend", () => {
    const p = { ...defaultProfile(), failover: { "gpt-6-sol#medium": "claude-opus-5-5#low" } };
    expect(validateProfile(p, loadCatalog())).toEqual([]);
  });

  test("refuses a failover target that is unscored", () => {
    const p = { ...defaultProfile(), failover: { "gpt-6-sol#medium": "gpt-6-luna#max" } };
    expect(validateProfile(p, loadCatalog())).toEqual([
      "failover: gpt-6-luna#max (stand-in for gpt-6-sol#medium) is unscored",
    ]);
  });

  test("refuses a failover target on the same backend as the rung it stands in for", () => {
    const p = { ...defaultProfile(), failover: { "gpt-6-sol#medium": "gpt-6-luna#high" } };
    expect(validateProfile(p, loadCatalog())).toEqual([
      "failover: gpt-6-luna#high is on the same backend (codex) as gpt-6-sol#medium; a stand-in must be on another backend",
    ]);
  });
});

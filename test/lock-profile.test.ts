import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { heavySlots, resolveSlots } from "../src/core/lock.ts";
import { configDir } from "../src/paths.ts";
import { defaultProfile, saveProfile, setActiveProfile } from "../src/profile/profile.ts";
import { withHome } from "./helpers.ts";

const saved = { ...process.env };
beforeEach(() => {
  withHome();
  delete process.env.CATHERD_LOCK_SLOTS;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("resolveSlots", () => {
  test("uses half the cores with no profile on disk", () => {
    expect(resolveSlots()).toBe(heavySlots("cpus/2"));
  });

  test("uses the active profile's lock.heavy", () => {
    saveProfile({ ...defaultProfile(), name: "small", lock: { heavy: 3 } });
    setActiveProfile("small");
    expect(resolveSlots()).toBe(3);
  });

  test("lets CATHERD_LOCK_SLOTS beat the profile, and --slots beat both", () => {
    saveProfile({ ...defaultProfile(), name: "small", lock: { heavy: 3 } });
    setActiveProfile("small");
    process.env.CATHERD_LOCK_SLOTS = "2";
    expect(resolveSlots()).toBe(2);
    expect(resolveSlots("5")).toBe(5);
    expect(resolveSlots("cpus/2")).toBe(heavySlots("cpus/2"));
  });

  test("refuses a slot count that is not a number", () => {
    expect(() => resolveSlots("lots")).toThrow(/slots must be a number or cpus\/2/);
  });

  test("falls back to half the cores when the profile is broken", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(configDir(), "profiles"), { recursive: true });
    writeFileSync(join(configDir(), "profiles", "default.json"), "{");
    expect(resolveSlots()).toBe(heavySlots("cpus/2"));
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

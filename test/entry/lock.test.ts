import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolveSlots } from "../../src/entry/lock.ts";
import { heavySlots } from "../../src/infra/heavy-lock.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd lock", () => {
  it("takes --slots, then CATHERD_LOCK_SLOTS, then the profile, then half the cores", () => {
    delete process.env.CATHERD_LOCK_SLOTS;
    expect(resolveSlots("3", () => 1)).toBe(3);
    process.env.CATHERD_LOCK_SLOTS = "2";
    expect(resolveSlots(undefined, () => 1)).toBe(2);
    delete process.env.CATHERD_LOCK_SLOTS;
    expect(resolveSlots(undefined, () => 4)).toBe(4);
    expect(
      resolveSlots(undefined, () => {
        throw new Error("no profile");
      }),
    ).toBe(heavySlots("cpus/2"));
    expect(() => resolveSlots("zero", () => 1)).toThrow(/slots/);
  });

  it("runs the command behind a slot and passes its exit code through", () => {
    const home = withHome();
    const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "sh", "-c", "exit 7"], {
      env: { ...process.env, CATHERD_HOME: home },
    });
    expect(p.exitCode).toBe(7);
  });
});

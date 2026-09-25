import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { heavySlots, withHeavySlot } from "../../src/infra/heavy-lock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("heavy lock", () => {
  it("reads a slot count from the profile setting", () => {
    expect(heavySlots(3)).toBe(3);
    expect(heavySlots(0)).toBe(1);
    expect(heavySlots("cpus/2")).toBeGreaterThanOrEqual(1);
    expect(heavySlots(undefined)).toBe(heavySlots("cpus/2"));
  });

  it("runs holders of a single slot one at a time", async () => {
    withHome();
    const log: string[] = [];
    const hold = (id: string) =>
      withHeavySlot(
        1,
        async () => {
          log.push(`${id}+`);
          await Bun.sleep(40);
          log.push(`${id}-`);
        },
        { pollMs: 5 },
      );
    await Promise.all([hold("a"), hold("b")]);
    expect(log).toHaveLength(4);
    expect(log[0]?.[0]).toBe(log[1]?.[0]);
    expect(existsSync(join(locksDir(), "slot-0.lock"))).toBe(false);
  });

  it("gives two holders two slots at once", async () => {
    withHome();
    const slots: number[] = [];
    let inside = 0;
    let most = 0;
    const hold = () =>
      withHeavySlot(2, async (slot) => {
        slots.push(slot);
        most = Math.max(most, ++inside);
        await Bun.sleep(40);
        inside--;
      });
    await Promise.all([hold(), hold()]);
    expect(slots.sort()).toEqual([0, 1]);
    expect(most).toBe(2);
  });

  it("reclaims a slot whose holder died, and one left empty by a crash mid-write", async () => {
    withHome();
    mkdirSync(locksDir(), { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(join(locksDir(), "slot-0.lock"), JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    expect(await withHeavySlot(1, (slot) => slot, { pollMs: 5 })).toBe(0);

    writeFileSync(join(locksDir(), "slot-0.lock"), "");
    const old = new Date(Date.now() - 6_000);
    utimesSync(join(locksDir(), "slot-0.lock"), old, old);
    expect(await withHeavySlot(1, (slot) => slot, { pollMs: 5 })).toBe(0);
  });

  it("tryLock refuses a lock this live process already holds, and releases only its own", () => {
    withHome();
    const target = join(locksDir(), "x");
    mkdirSync(locksDir(), { recursive: true });
    const release = tryLock(target);
    expect(release).not.toBeNull();
    expect(tryLock(target)).toBeNull();
    release?.();
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});

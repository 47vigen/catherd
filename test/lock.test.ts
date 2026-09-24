import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { acquire, heavySlots, LOCK_STALE_MS } from "../src/core/lock.ts";
import { dataDir } from "../src/paths.ts";
import { withHome } from "./helpers.ts";

describe("lock", () => {
  beforeEach(() => withHome());

  test("computes slots from the setting", () => {
    expect(heavySlots(3)).toBe(3);
    expect(heavySlots("cpus/2")).toBeGreaterThanOrEqual(1);
    expect(heavySlots(undefined)).toBeGreaterThanOrEqual(1);
    expect(heavySlots(0)).toBe(1);
  });

  test("gives out at most N slots at once and hands a freed slot to the next waiter", async () => {
    const a = await acquire(2, "a", 20);
    const b = await acquire(2, "b", 20);
    let cGot = false;
    const c = acquire(2, "c", 20).then((l) => {
      cGot = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(cGot).toBe(false);
    await a.release();
    const cl = await c;
    expect(cl.slot).toBe(a.slot);
    await b.release();
    await cl.release();
    expect(readdirSync(join(dataDir(), "locks"))).toEqual([]);
  });

  test("reclaims a slot whose holder died", async () => {
    const dir = join(dataDir(), "locks");
    mkdirSync(dir, { recursive: true });
    const holder = Bun.spawn(["bun", "-e", "await new Promise(() => {})"]);
    writeFileSync(join(dir, "slot-0"), JSON.stringify({ pid: holder.pid, label: "x" }));
    holder.kill("SIGKILL");
    await holder.exited;

    const started = Date.now();
    const l = await acquire(1, "y", 100);
    expect(l.slot).toBe(0);
    expect(Date.now() - started).toBeLessThan(LOCK_STALE_MS + 2_000);
    await l.release();
  });
});

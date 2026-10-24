import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { roleScopeOfScratch } from "../../src/domain/role-scope.ts";
import {
  heavyLimits,
  heavySlots,
  type LockWait,
  roleLockOwner,
  slotTmpDir,
  withHeavySlot,
  withRoleLock,
} from "../../src/infra/heavy-lock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { selfIdentity } from "../../src/infra/proc.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

const limits = { ...heavyLimits };
afterEach(() => Object.assign(heavyLimits, limits));
afterEach(snapshotEnv());

/** A signal a test awaits instead of sleeping: `fire` settles `done`. */
function signal(): { done: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const done = new Promise<void>((resolve) => (fire = resolve));
  return { done, fire };
}

describe("heavy lock", () => {
  it("waits while the load is above twice the cores, then runs", async () => {
    withHome();
    let reads = 0;
    Object.assign(heavyLimits, {
      cores: () => 4,
      load: () => (reads++ < 2 ? 9 : 1),
      loadPollMs: 1,
      loadWaitMs: 60_000,
    });
    let waits = 0;
    expect(await withHeavySlot(1, () => "ran", { pollMs: 1, onWait: () => waits++ })).toBe("ran");
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(waits).toBeGreaterThanOrEqual(2);
  });

  it("does not wait for the host's load under test: a busy CI runner must not stall a lock", async () => {
    withHome();
    Object.assign(heavyLimits, { cores: () => 1, load: () => 99 });
    expect(heavyLimits.loadWaitMs).toBe(0);
    expect(await withHeavySlot(1, () => "ran", { pollMs: 1 })).toBe("ran");
  });

  it("runs anyway once the load wait is spent", async () => {
    withHome();
    Object.assign(heavyLimits, { cores: () => 1, load: () => 99, loadPollMs: 1, loadWaitMs: 5 });
    expect(await withHeavySlot(1, () => "ran", { pollMs: 1 })).toBe("ran");
  });

  it("gives each command an emptied temp dir and removes it after", async () => {
    withHome();
    const first = await withHeavySlot(1, (_s, tmp) => (writeFileSync(join(tmp, "x"), "1"), tmp));
    expect(existsSync(first)).toBe(false);
    expect(await withHeavySlot(1, (_s, tmp) => readdirSync(tmp))).toEqual([]);
  });

  it("keeps a role's scratch as the base of its slot temp dir", () => {
    withHome();
    const scratch = "/d/runs/20261012-101010-r/scratch/verifier-M1";
    expect(slotTmpDir(0, scratch)).toBe(`${scratch}/heavy-0`);
    expect(roleScopeOfScratch(slotTmpDir(0, scratch))).toEqual({
      run: "20261012-101010-r",
      name: "verifier-M1",
    });
    expect(slotTmpDir(1, "/tmp")).toBe(join(locksDir(), "tmp", "slot-1"));
  });

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

  it("keeps another run's verifier out until the last command of the holding run ends", async () => {
    withHome();
    const log: string[] = [];
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => (releaseA = resolve));
    let enteredA!: () => void;
    const insideA = new Promise<void>((resolve) => (enteredA = resolve));
    const a = withRoleLock(
      "verifier",
      "run:A",
      async () => {
        log.push("A+");
        enteredA();
        await heldA;
        log.push("A-");
      },
      { pollMs: 5 },
    );
    await insideA;
    expect(roleLockOwner("verifier")).toBe("run:A");
    // the same run shares it: its second command runs side by side
    await withRoleLock("verifier", "run:A", () => log.push("A2"), { pollMs: 5 });
    const b = withRoleLock("verifier", "run:B", () => log.push("B"), { pollMs: 5 });
    await Bun.sleep(50);
    expect(log).toEqual(["A+", "A2"]);
    releaseA();
    await Promise.all([a, b]);
    expect(log).toEqual(["A+", "A2", "A-", "B"]);
    expect(roleLockOwner("verifier")).toBeNull();
  });

  it("writes the role lock with schema 1, reads one written without it, and refuses a newer one", async () => {
    withHome();
    const file = join(locksDir(), "role-verifier.json");
    await withRoleLock("verifier", "run:A", () => {
      expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe(1);
    });
    expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe(1);
    const legacy = { owner: "run:A", holders: [{ ...selfIdentity(), token: "t" }] };
    writeFileSync(file, JSON.stringify(legacy));
    expect(roleLockOwner("verifier")).toBe("run:A");
    writeFileSync(file, JSON.stringify({ ...legacy, schema: 2 }));
    expect(() => roleLockOwner("verifier")).toThrow(
      expect.objectContaining({ code: "E_CONFIG_NEWER_SCHEMA" }),
    );
  });

  it("treats damaged role-lock files as free", () => {
    withHome();
    mkdirSync(locksDir(), { recursive: true });
    const file = join(locksDir(), "role-verifier.json");
    for (const contents of ["{", "null", JSON.stringify({ owner: "run:A", holders: [null] })]) {
      writeFileSync(file, contents);
      expect(roleLockOwner("verifier")).toBeNull();
    }
  });

  it("drops a role-lock holder that died", async () => {
    withHome();
    mkdirSync(locksDir(), { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(
      join(locksDir(), "role-verifier.json"),
      JSON.stringify({ owner: "run:A", holders: [{ pid: dead.pid, startTime: "gone", token: "t" }] }),
    );
    expect(await withRoleLock("verifier", "run:B", () => "in", { pollMs: 5 })).toBe("in");
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

  it("slots go in arrival order", async () => {
    withHome();
    const log: string[] = [];
    const inside = signal();
    const hold = signal();
    const first = withHeavySlot(
      1,
      async () => {
        inside.fire();
        await hold.done;
      },
      { pollMs: 5 },
    );
    await inside.done;
    const bQueued = signal();
    const cQueued = signal();
    const b = withHeavySlot(1, () => log.push("B"), { pollMs: 5, onWait: () => bQueued.fire() });
    await bQueued.done;
    const c = withHeavySlot(1, () => log.push("C"), { pollMs: 5, onWait: () => cQueued.fire() });
    // both poll when the slot frees: only the oldest ticket may take it
    await cQueued.done;
    hold.fire();
    await Promise.all([first, b, c]);
    expect(log).toEqual(["B", "C"]);
  });

  it("a busy run cannot keep the role lock from an earlier waiter", async () => {
    withHome();
    const log: string[] = [];
    const inside = signal();
    const hold = signal();
    const first = withRoleLock(
      "verifier",
      "run:a",
      async () => {
        log.push("a1+");
        inside.fire();
        await hold.done;
        log.push("a1-");
      },
      { pollMs: 5 },
    );
    await inside.done;
    const bQueued = signal();
    const b = withRoleLock("verifier", "run:b", () => log.push("b"), {
      pollMs: 5,
      onWait: () => bQueued.fire(),
    });
    await bQueued.done;
    const aQueued = signal();
    // run:a's second command could join its own lock at once, but run:b's waiter is ahead of it
    const second = withRoleLock("verifier", "run:a", () => log.push("a2"), {
      pollMs: 5,
      onWait: () => aQueued.fire(),
    });
    await aQueued.done;
    hold.fire();
    await Promise.all([first, b, second]);
    expect(log).toEqual(["a1+", "a1-", "b", "a2"]);
  });

  it("a role wait past roleWaitMs enters anyway", async () => {
    withHome();
    Object.assign(heavyLimits, { roleWaitMs: 50 });
    const inside = signal();
    const hold = signal();
    let aDone = false;
    const a = withRoleLock(
      "verifier",
      "run:a",
      async () => {
        inside.fire();
        await hold.done;
        aDone = true;
      },
      { pollMs: 5 },
    );
    await inside.done;
    const seen: LockWait[] = [];
    // run:b runs while run:a still holds the lock; its last report names the holder it entered beside
    await withRoleLock("verifier", "run:b", () => expect(aDone).toBe(false), {
      pollMs: 5,
      onWait: (w) => seen.push(w),
    });
    expect(seen.at(-1)).toMatchObject({ lock: "role-verifier", holder: "run:a" });
    expect(seen.at(-1)?.waitedMs).toBeGreaterThanOrEqual(50);
    hold.fire();
    await a;
  });

  it("onWait names the holder and the queue ahead", async () => {
    withHome();
    const inside = signal();
    const hold = signal();
    const a = withRoleLock(
      "verifier",
      "run:a",
      async () => {
        inside.fire();
        await hold.done;
      },
      { pollMs: 5 },
    );
    await inside.done;
    const bReports: LockWait[] = [];
    const bQueued = signal();
    const b = withRoleLock("verifier", "run:b", () => {}, {
      pollMs: 5,
      onWait: (w) => {
        bReports.push(w);
        bQueued.fire();
      },
    });
    await bQueued.done;
    const cReports: LockWait[] = [];
    const cQueued = signal();
    const c = withRoleLock("verifier", "run:c", () => {}, {
      pollMs: 5,
      onWait: (w) => {
        cReports.push(w);
        cQueued.fire();
      },
    });
    await cQueued.done;
    expect(bReports[0]).toMatchObject({ lock: "role-verifier", holder: "run:a", ahead: 0 });
    expect(cReports[0]).toMatchObject({ lock: "role-verifier", holder: "run:a", ahead: 1 });
    hold.fire();
    await Promise.all([a, b, c]);
  });

  it("low disk holds a slot within the load deadline", async () => {
    withHome();
    let checks = 0;
    Object.assign(heavyLimits, {
      cores: () => 4,
      load: () => 0,
      loadWaitMs: 60_000,
      loadPollMs: 1,
      freeMb: () => (checks++ < 2 ? 100 : 10_000),
    });
    let waits = 0;
    let runs = 0;
    expect(await withHeavySlot(1, () => ++runs, { pollMs: 1, onWait: () => waits++ })).toBe(1);
    expect(waits).toBe(2);
    expect(runs).toBe(1);
  });

  it("does not hold a slot for a disk it cannot read", async () => {
    withHome();
    Object.assign(heavyLimits, { cores: () => 4, load: () => 0, loadWaitMs: 60_000, loadPollMs: 1 });
    const statfs = spyOn(fs, "statfsSync").mockImplementation(() => {
      throw Object.assign(new Error("statfs failed"), { code: "ENOSYS" });
    });
    let waits = 0;
    try {
      expect(heavyLimits.freeMb()).toBe(Number.POSITIVE_INFINITY);
      expect(await withHeavySlot(1, () => "ran", { pollMs: 1, onWait: () => waits++ })).toBe("ran");
    } finally {
      statfs.mockRestore();
    }
    expect(waits).toBe(0);
  });

  it("drops the ticket of a waiter that died, on the next look", async () => {
    withHome();
    mkdirSync(locksDir(), { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const ticket = { pid: dead.pid, startTime: "gone", token: "t", at: 0 };
    writeFileSync(join(locksDir(), "queue-heavy.json"), JSON.stringify({ schema: 1, tickets: [ticket] }));
    writeFileSync(
      join(locksDir(), "queue-role-verifier.json"),
      JSON.stringify({ schema: 1, tickets: [{ ...ticket, owner: "run:A" }] }),
    );
    expect(await withHeavySlot(1, () => "ran", { pollMs: 5 })).toBe("ran");
    expect(await withRoleLock("verifier", "run:B", () => "in", { pollMs: 5 })).toBe("in");
    expect(JSON.parse(readFileSync(join(locksDir(), "queue-heavy.json"), "utf8")).tickets).toEqual([]);
  });
});

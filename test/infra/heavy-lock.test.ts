import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { roleScopeOfScratch } from "../../src/domain/role-scope.ts";
import {
  heavyLimits,
  heavySlots,
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
});

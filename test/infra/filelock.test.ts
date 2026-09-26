import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, withFileLockSync } from "../../src/infra/filelock.ts";

const target = () => join(mkdtempSync(join(tmpdir(), "catherd-lock-")), "profile.json");

describe("withFileLock", () => {
  it("serialises concurrent critical sections", async () => {
    const t = target();
    const log: string[] = [];
    const section = (id: string) =>
      withFileLock(
        t,
        async () => {
          log.push(`${id}+`);
          await Bun.sleep(30);
          log.push(`${id}-`);
        },
        { pollMs: 5 },
      );
    await Promise.all([section("a"), section("b"), section("c")]);
    for (let i = 0; i < log.length; i += 2) expect(log[i]?.[0]).toBe(log[i + 1]?.[0]);
    expect(existsSync(`${t}.lock`)).toBe(false);
  });

  it("reclaims a lock whose holder is dead", async () => {
    const t = target();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    expect(await withFileLock(t, () => 42, { timeoutMs: 1000, pollMs: 5 })).toBe(42);
  });

  it("times out with E_IO_LOCK while a live holder keeps it", async () => {
    const t = target();
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: process.pid, startTime: null }));
    await expect(withFileLock(t, () => 1, { timeoutMs: 60, pollMs: 5 })).rejects.toThrow(/lock/);
  });

  it("releases the lock when the section throws", async () => {
    const t = target();
    await expect(
      withFileLock(t, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(`${t}.lock`)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "treats a live pid 1 holder as valid and never reclaims it",
    async () => {
      const t = target();
      writeFileSync(`${t}.lock`, JSON.stringify({ pid: 1, startTime: null }));
      const old = new Date(Date.now() - 6_000);
      utimesSync(`${t}.lock`, old, old);
      await expect(withFileLock(t, () => 1, { timeoutMs: 60, pollMs: 5 })).rejects.toThrow(/lock/);
      expect(existsSync(`${t}.lock`)).toBe(true);
    },
  );

  it("reclaims an empty or unparsable lock only once it is older than 5 s", async () => {
    for (const content of ["", "{not json", JSON.stringify({ pid: 0, startTime: null })]) {
      const t = target();
      writeFileSync(`${t}.lock`, content);
      await expect(withFileLock(t, () => 1, { timeoutMs: 60, pollMs: 5 })).rejects.toThrow(/lock/);
      const old = new Date(Date.now() - 6_000);
      utimesSync(`${t}.lock`, old, old);
      expect(await withFileLock(t, () => 2, { timeoutMs: 1000, pollMs: 5 })).toBe(2);
    }
  });

  it("waits while another waiter is reclaiming, and clears a reclaim marker older than 5 s", async () => {
    const t = target();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    writeFileSync(`${t}.lock.reclaim`, "");
    await expect(withFileLock(t, () => 1, { timeoutMs: 60, pollMs: 5 })).rejects.toThrow(/lock/);
    const old = new Date(Date.now() - 6_000);
    utimesSync(`${t}.lock.reclaim`, old, old);
    expect(await withFileLock(t, () => 2, { timeoutMs: 1000, pollMs: 5 })).toBe(2);
    expect(existsSync(`${t}.lock.reclaim`)).toBe(false);
  });

  it("keeps mutual exclusion while processes race to reclaim dead holders' locks", async () => {
    const t = target();
    writeFileSync(t, "0");
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    const worker = join(import.meta.dir, "fixtures", "lock-worker.ts");
    const workers = 5;
    const iterations = 20;
    const startAt = Date.now() + 500;
    const counting = Array.from({ length: workers }, () =>
      Bun.spawn(["bun", worker, "count", t, String(iterations), String(startAt)], {
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    // Crashers die holding the lock, so the counting workers repeatedly race to reclaim it.
    const crashers: Promise<number>[] = [];
    await Bun.sleep(500);
    for (let i = 0; i < 10; i++) {
      crashers.push(Bun.spawn(["bun", worker, "crash", t], { stdout: "ignore", stderr: "ignore" }).exited);
      await Bun.sleep(20);
    }
    expect(await Promise.all(counting.map((p) => p.exited))).toEqual(Array(workers).fill(0));
    await Promise.all(crashers);
    expect(Number(readFileSync(t, "utf8"))).toBe(workers * iterations);
  }, 60_000);
});

describe("withFileLockSync", () => {
  it("runs the section holding the lock, then releases it", () => {
    const t = target();
    expect(withFileLockSync(t, () => existsSync(`${t}.lock`))).toBe(true);
    expect(existsSync(`${t}.lock`)).toBe(false);
  });

  it("reclaims a dead holder's lock, and times out with E_IO_LOCK behind a live one", async () => {
    const t = target();
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    expect(withFileLockSync(t, () => 7, { timeoutMs: 1000, pollMs: 5 })).toBe(7);
    writeFileSync(`${t}.lock`, JSON.stringify({ pid: process.pid, startTime: null }));
    expect(() => withFileLockSync(t, () => 1, { timeoutMs: 60, pollMs: 5 })).toThrow(
      expect.objectContaining({ code: "E_IO_LOCK" }),
    );
  });

  it("releases the lock when the section throws", () => {
    const t = target();
    expect(() =>
      withFileLockSync(t, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${t}.lock`)).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../src/infra/filelock.ts";

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
});

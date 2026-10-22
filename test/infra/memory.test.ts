import { describe, expect, it } from "bun:test";
import { freemem, totalmem } from "node:os";
import { availableMemoryMb } from "../../src/infra/memory.ts";

describe("availableMemoryMb", () => {
  it("reads macOS's free percentage, Linux's MemAvailable, and falls back to os.freemem", () => {
    expect(availableMemoryMb({ platform: "darwin", sysctl: () => "50\n" })).toBe(
      Math.floor((0.5 * totalmem()) / 2 ** 20),
    );
    expect(
      availableMemoryMb({
        platform: "linux",
        meminfo: () => "MemTotal: 1 kB\nMemAvailable:    8388608 kB\n",
      }),
    ).toBe(8192);
    const free = Math.floor(freemem() / 2 ** 20);
    for (const o of [
      { platform: "darwin" as const, sysctl: () => null },
      { platform: "darwin" as const, sysctl: () => "x" },
      { platform: "darwin" as const, sysctl: () => "101" },
      { platform: "linux" as const, meminfo: () => "MemFree: 1 kB" },
      { platform: "win32" as const },
    ])
      expect(Math.abs(availableMemoryMb(o) - free)).toBeLessThan(256); // freemem moves between reads
  });

  it("reads the real machine without throwing", () => expect(availableMemoryMb()).toBeGreaterThan(0));
});

import { describe, expect, it } from "bun:test";
import { isAlive, killGroup, processStartTime } from "../../src/infra/proc.ts";

describe("proc", () => {
  it("identifies a live process by pid and start time", () => {
    const start = processStartTime(process.pid);
    expect(start).not.toBeNull();
    expect(isAlive(process.pid, start)).toBe(true);
    expect(isAlive(process.pid, null)).toBe(true);
  });

  it("treats a live pid with a different start time as a different process (pid reuse)", () => {
    expect(isAlive(process.pid, "0-not-the-real-start")).toBe(false);
  });

  it("reports a dead pid as not alive", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    expect(isAlive(p.pid, null)).toBe(false);
  });

  it("kills a detached child's whole group", async () => {
    const p = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    killGroup(p.pid, "SIGKILL");
    await p.exited;
    expect(p.signalCode).toBe("SIGKILL");
  });
});

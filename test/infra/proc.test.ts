import { describe, expect, it, spyOn } from "bun:test";
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

  describe("invalid pids", () => {
    it("killGroup never signals a pid that is not an integer > 1 (0 and -1 are whole groups)", () => {
      const kill = spyOn(process, "kill").mockImplementation(() => true);
      try {
        for (const pid of [0, 1, -5, 1.5, Number.NaN]) killGroup(pid, "SIGKILL");
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    });

    it("isAlive reports a pid that is not an integer >= 1 as not alive", () => {
      for (const pid of [0, -1, 1.5, Number.NaN]) expect(isAlive(pid, null)).toBe(false);
    });

    it.skipIf(process.platform !== "linux")(
      "isAlive accepts pid 1 (init, or catherd as a container entrypoint)",
      () => {
        expect(isAlive(1, null)).toBe(true);
      },
    );
  });

  it("runs the ps fallback in the C locale and UTC so start times compare across environments", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    const spawn = spyOn(Bun, "spawnSync");
    try {
      processStartTime(p.pid);
      const calls = spawn.mock.calls as unknown as [string[], { env?: Record<string, string> }][];
      const ps = calls.find(([cmd]) => cmd[0] === "ps");
      expect(ps?.[1].env?.LC_ALL).toBe("C");
      expect(ps?.[1].env?.TZ).toBe("UTC");
    } finally {
      spawn.mockRestore();
    }
  });
});

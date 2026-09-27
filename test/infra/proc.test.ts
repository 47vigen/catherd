import { describe, expect, it, spyOn } from "bun:test";
import {
  isAlive,
  isSurelyAlive,
  killGroup,
  processStartTime,
  psStartTime,
  sameProcess,
  surelySame,
} from "../../src/infra/proc.ts";

describe("proc", () => {
  it("never takes an unreadable or unrecorded start time as the same process for a signal", () => {
    expect(surelySame("a", null)).toBe(false);
    expect(surelySame(null, "a")).toBe(false);
    expect(surelySame("a", "b")).toBe(false);
    expect(surelySame("a", "a")).toBe(true);
    expect(sameProcess("a", null)).toBe(true);
    expect(isSurelyAlive(process.pid, processStartTime(process.pid))).toBe(true);
    expect(isSurelyAlive(process.pid, null)).toBe(false);
  });

  it("reads a start time with ps even when PATH does not name ps's folder (macOS has no /proc)", () => {
    expect(psStartTime(process.pid, { PATH: "/nonexistent" })).not.toBeNull();
  });

  it("answers null instead of throwing when ps cannot run", () => {
    expect(psStartTime(-5, { PATH: "/nonexistent" })).toBeNull();
  });

  it("identifies a live process by pid and start time", () => {
    const start = processStartTime(process.pid);
    expect(start).not.toBeNull();
    expect(isAlive(process.pid, start)).toBe(true);
    expect(isAlive(process.pid, null)).toBe(true);
  });

  it("treats a live pid with a different start time as a different process (pid reuse)", () => {
    expect(isAlive(process.pid, "0-not-the-real-start")).toBe(false);
  });

  it("takes a live pid whose start time cannot be read now for the same process (a transient ps failure)", () => {
    expect(sameProcess("Mon Sep 28 10:00:00 2026", null)).toBe(true);
    expect(sameProcess("Mon Sep 28 10:00:00 2026", "Mon Sep 28 10:00:00 2026")).toBe(true);
    expect(sameProcess("Mon Sep 28 10:00:00 2026", "Mon Sep 28 10:05:00 2026")).toBe(false);
    expect(sameProcess(null, "anything")).toBe(true);
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

  it("killGroup never falls back to a bare pid whose group is gone: that pid may be reused", () => {
    const kill = spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    });
    try {
      killGroup(424242, "SIGKILL");
      expect(kill.mock.calls.map((c) => c[0])).toEqual([-424242]);
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")("isAlive reports a zombie no one reaps as dead", async () => {
    // `true` exits at once; its parent then execs sleep, which never reaps it
    const p = Bun.spawn(["sh", "-c", "true & echo $!; exec sleep 5"], { stdout: "pipe" });
    try {
      const reader = p.stdout.getReader();
      const zombie = Number(new TextDecoder().decode((await reader.read()).value).trim());
      await Bun.sleep(200);
      expect(isAlive(zombie, null)).toBe(false);
    } finally {
      p.kill("SIGKILL");
    }
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
      const ps = calls.find(([cmd]) => cmd[0]?.endsWith("ps"));
      expect(ps?.[1].env?.LC_ALL).toBe("C");
      expect(ps?.[1].env?.TZ).toBe("UTC");
    } finally {
      spawn.mockRestore();
    }
  });
});

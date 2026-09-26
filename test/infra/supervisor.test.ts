import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
// the supervisor logs each spawn (spec §10.2): keep the rows out of the real data dir
beforeEach(() => void withHome());

function spec(script: string, over: Partial<SuperviseSpec> = {}): SuperviseSpec {
  const dir = mkdtempSync(join(tmpdir(), "catherd-sup-"));
  return {
    schema: 1,
    backend: "test",
    dispatchDir: dir,
    cmd: "sh",
    args: ["-c", script],
    env: { PATH: process.env.PATH ?? "" },
    cwd: dir,
    stdinPath: null,
    idleMs: 5_000,
    wallMs: 10_000,
    killGraceMs: 200,
    graceAfterFinalMs: null,
    pollMs: 20,
    ...over,
  };
}

describe("supervise", () => {
  it("runs to exit, captures stdout and stderr to files, and writes proc.json and exit.json", async () => {
    const s = spec(`echo '{"type":"a"}'; echo oops 1>&2; exit 3`);
    const exit = await supervise(s);
    const p = dispatchPaths(s.dispatchDir);
    expect(exit).toMatchObject({ code: 3, signal: null, reason: "exited" });
    expect(readExit(s.dispatchDir)).toMatchObject({ code: 3, reason: "exited" });
    expect(readFileSync(p.events, "utf8")).toBe('{"type":"a"}\n');
    expect(readFileSync(p.stderr, "utf8")).toBe("oops\n");
    const proc = JSON.parse(readFileSync(p.proc, "utf8"));
    expect(proc.pgid).toBe(proc.pid);
    expect(proc).toMatchObject({ schema: 1, pid: expect.any(Number) });
  });

  it("feeds stdin from a file and sets the working directory", async () => {
    const s = spec("cat; pwd");
    const brief = join(s.dispatchDir, "brief.md");
    writeFileSync(brief, "the brief\n");
    await supervise({ ...s, stdinPath: brief });
    const out = readFileSync(dispatchPaths(s.dispatchDir).events, "utf8");
    expect(out).toContain("the brief");
    expect(out).toContain(s.dispatchDir);
  });

  it("stops an idle child, asking isBusy first", async () => {
    let asked = 0;
    const s = spec("sleep 30", { idleMs: 100 });
    const exit = await supervise(s, {
      isBusy: async () => {
        asked++;
        return false;
      },
    });
    expect(exit.reason).toBe("idle-timeout");
    expect(asked).toBeGreaterThan(0);
  });

  it("stops a busy-but-too-long child at the wall limit, interrupting first", async () => {
    let interrupted = false;
    const s = spec("sleep 30", { idleMs: 50, wallMs: 300 });
    const exit = await supervise(s, {
      isBusy: async () => true,
      interrupt: async () => {
        interrupted = true;
      },
    });
    expect(exit.reason).toBe("wall-timeout");
    expect(interrupted).toBe(true);
  });

  it("kills a CLI that lingers after its final event", async () => {
    const s = spec(`echo '{"type":"result"}'; sleep 30`, { graceAfterFinalMs: 100 });
    const exit = await supervise(s, { onLine: (l) => ({ final: l.includes("result") }) });
    expect(exit.reason).toBe("after-final");
  });

  it("stops on a cancel request and escalates to SIGKILL when SIGTERM is ignored", async () => {
    const s = spec(`trap '' TERM; sleep 30`, { killGraceMs: 100 });
    setTimeout(() => requestCancel(s.dispatchDir), 100);
    const exit = await supervise(s);
    expect(exit.reason).toBe("cancelled");
    expect(exit.signal).toBe("SIGKILL");
  });
});

/** Gone, or a zombie nobody has reaped yet (a container's pid 1 may never reap). */
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

describe("supervise always leaves exit.json and no live worker", () => {
  it("records a binary that cannot be spawned as lost, with the error in stderr", async () => {
    const s = { ...spec(""), cmd: "catherd-no-such-binary-4f2a", args: [] };
    const exit = await supervise(s);
    expect(exit).toMatchObject({ code: null, signal: null, reason: "lost" });
    expect(readExit(s.dispatchDir)).toMatchObject({ code: null, reason: "lost" });
    expect(readFileSync(dispatchPaths(s.dispatchDir).stderr, "utf8")).toContain(
      "catherd-no-such-binary-4f2a",
    );
  });

  it("treats an isBusy that rejects as not busy", async () => {
    const s = spec("sleep 30", { idleMs: 100 });
    const exit = await supervise(s, {
      isBusy: async () => {
        throw new Error("probe failed");
      },
    });
    expect(exit.reason).toBe("idle-timeout");
    expect(readExit(s.dispatchDir)?.reason).toBe("idle-timeout");
  });

  it("ignores a line whose onLine throws and still completes", async () => {
    const s = spec(`echo one; echo two`);
    const seen: string[] = [];
    const exit = await supervise(s, {
      onLine: (l) => {
        seen.push(l);
        throw new Error("bad line");
      },
    });
    expect(exit).toMatchObject({ code: 0, reason: "exited" });
    expect(readExit(s.dispatchDir)?.reason).toBe("exited");
    expect(seen).toEqual(["one", "two"]);
  });

  it("stops the worker and still writes exit.json when proc.json cannot be written", async () => {
    const s = spec("sleep 30");
    mkdirSync(join(dispatchPaths(s.dispatchDir).proc, "blocker"), { recursive: true });
    const t0 = Date.now();
    await expect(supervise(s)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(readExit(s.dispatchDir)?.reason).toBe("lost");
  });
});

describe("supervise bounds its hooks", () => {
  it("stops at idle when isBusy never answers", async () => {
    const s = spec("sleep 30", { idleMs: 100 });
    const t0 = Date.now();
    const exit = await supervise(s, { isBusy: () => new Promise<boolean>(() => {}) });
    expect(exit.reason).toBe("idle-timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("kills anyway when interrupt never returns", async () => {
    const s = spec("sleep 30", { idleMs: 200, wallMs: 400 });
    const t0 = Date.now();
    const exit = await supervise(s, {
      isBusy: async () => true,
      interrupt: () => new Promise<void>(() => {}),
    });
    expect(exit.reason).toBe("wall-timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("does not kill a worker that exited while being interrupted", async () => {
    const s = spec(`while [ ! -f stop ]; do sleep 0.02; done; exit 7`, { idleMs: 100, killGraceMs: 2000 });
    const exit = await supervise(s, {
      interrupt: async () => {
        writeFileSync(join(s.dispatchDir, "stop"), "");
        await Bun.sleep(300);
      },
    });
    expect(exit).toMatchObject({ code: 7, signal: null, reason: "idle-timeout" });
  });
});

describe("supervise signals the whole group", () => {
  it("SIGKILLs a group member that ignores SIGTERM even when the leader exits", async () => {
    const s = spec(`(trap '' TERM; sleep 30) & echo $!; sleep 30`, { killGraceMs: 150 });
    const events = dispatchPaths(s.dispatchDir).events;
    let member = 0;
    const exit = await supervise(s, {
      onLine: (l) => {
        member = Number(l);
        requestCancel(s.dispatchDir);
        return {};
      },
    });
    expect(exit.reason).toBe("cancelled");
    expect(member).toBeGreaterThan(0);
    expect(readFileSync(events, "utf8").trim()).toBe(String(member));
    await Bun.sleep(100);
    expect(dead(member)).toBe(true);
  });

  it("kills a group member left behind when the worker exits on its own", async () => {
    const s = spec(`sleep 30 & echo $!; exit 0`);
    const events = dispatchPaths(s.dispatchDir).events;
    const exit = await supervise(s);
    const member = Number(readFileSync(events, "utf8").trim());
    expect(member).toBeGreaterThan(0);
    expect(exit).toMatchObject({ code: 0, signal: null, reason: "exited" });
    expect(readExit(s.dispatchDir)).toMatchObject({ code: 0, reason: "exited" });
    await Bun.sleep(100);
    expect(dead(member)).toBe(true);
  });
});

describe("supervise decodes output", () => {
  it("keeps a multi-byte character split across polls intact", async () => {
    const s = spec(`printf '\\303\\251\\360\\237'; sleep 0.2; printf '\\220\\210\\n'`);
    const seen: string[] = [];
    await supervise(s, {
      onLine: (l) => {
        seen.push(l);
        return {};
      },
    });
    expect(seen).toEqual(["é🐈"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import * as store from "../../src/infra/store.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
import { exited, snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
// the supervisor logs each spawn (spec §10.2): keep the rows out of the real data dir
beforeEach(() => void withHome());

function spec(script: string, over: Partial<SuperviseSpec> = {}): SuperviseSpec {
  const dir = tempDir("catherd-sup-");
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
    expect(exit?.reason).toBe("idle-timeout");
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
    expect(exit?.reason).toBe("wall-timeout");
    expect(interrupted).toBe(true);
  });

  it("kills a CLI that lingers after its final event", async () => {
    const s = spec(`echo '{"type":"result"}'; sleep 30`, { graceAfterFinalMs: 100 });
    const exit = await supervise(s, { onLine: (l) => ({ final: l.includes("result") }) });
    expect(exit?.reason).toBe("after-final");
  });

  it("stops on a cancel request and escalates to SIGKILL when SIGTERM is ignored", async () => {
    const s = spec(`trap '' TERM; sleep 30`, { killGraceMs: 100 });
    setTimeout(() => requestCancel(s.dispatchDir), 100);
    const exit = await supervise(s);
    expect(exit?.reason).toBe("cancelled");
    expect(exit?.signal).toBe("SIGKILL");
  });
});

describe("supervise reports a stall (spec §3.6)", () => {
  it("writes stall.json once the worker is quiet for half its idle timeout and not busy", async () => {
    const s = spec(`echo '{"type":"a"}'; sleep 30`, { idleMs: 400 });
    const exit = await supervise(s, { isBusy: async () => false });
    expect(exit?.reason).toBe("idle-timeout");
    const stall = JSON.parse(readFileSync(dispatchPaths(s.dispatchDir).stall, "utf8"));
    expect(stall).toMatchObject({ schema: 1, at: expect.any(String) });
    expect(stall.quietMs).toBeGreaterThanOrEqual(200);
  });

  it("writes it once per dispatch, however many quiet stretches follow", async () => {
    // quiet, a line, quiet again: the second stretch is a stall too, and is not reported again
    const s = spec(`sleep 0.4; echo '{"type":"a"}'; sleep 0.4; echo '{"type":"b"}'`, { idleMs: 600 });
    let first: string | null = null;
    const exit = await supervise(s, {
      isBusy: async () => false,
      onLine: () => {
        first ??= readFileSync(dispatchPaths(s.dispatchDir).stall, "utf8");
        return {};
      },
    });
    expect(exit?.reason).toBe("exited");
    expect(first).not.toBeNull();
    expect(readFileSync(dispatchPaths(s.dispatchDir).stall, "utf8")).toBe(first as unknown as string);
  });

  it("keeps supervising a healthy worker when the advisory stall.json write fails", async () => {
    const real = store.writeJsonAtomic;
    const spy = spyOn(store, "writeJsonAtomic").mockImplementation((file, value, o) => {
      if (file.endsWith("stall.json")) throw new Error("ENOSPC: no space left on device");
      real(file, value, o);
    });
    try {
      const s = spec(`echo '{"type":"a"}'; sleep 0.5; echo '{"type":"b"}'`, { idleMs: 800 });
      const exit = await supervise(s, { isBusy: async () => false });
      expect(exit).toMatchObject({ code: 0, reason: "exited" });
      expect(readFileSync(dispatchPaths(s.dispatchDir).events, "utf8")).toContain('"b"');
    } finally {
      spy.mockRestore();
    }
  });

  it("asks again in the next quiet stretch when the full idle check found the worker busy", async () => {
    // busy at the half-way check and at the idle check, then quiet and not busy: that stretch is a stall
    const answers = [true, true];
    const s = spec("sleep 30", { idleMs: 300 });
    const exit = await supervise(s, { isBusy: async () => answers.shift() ?? false });
    expect(exit?.reason).toBe("idle-timeout");
    expect(existsSync(dispatchPaths(s.dispatchDir).stall)).toBe(true);
  });

  it("reports no stall while the worker is busy, or has a tool call open", async () => {
    const busy = spec("sleep 30", { idleMs: 200, wallMs: 600 });
    expect((await supervise(busy, { isBusy: async () => true }))?.reason).toBe("wall-timeout");
    expect(existsSync(dispatchPaths(busy.dispatchDir).stall)).toBe(false);
    const open = spec(`echo '{"open":"t1"}'; sleep 30`, { idleMs: 200, wallMs: 600 });
    const exit = await supervise(open, {
      onLine: (l) => (l.includes("open") ? { item: { id: "t1", open: true } } : {}),
      isBusy: async () => false,
    });
    expect(exit?.reason).toBe("wall-timeout");
    expect(existsSync(dispatchPaths(open.dispatchDir).stall)).toBe(false);
  });
});

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
    expect(exit?.reason).toBe("idle-timeout");
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
    expect(exit?.reason).toBe("idle-timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("kills anyway when interrupt never returns", async () => {
    const s = spec("sleep 30", { idleMs: 200, wallMs: 400 });
    const t0 = Date.now();
    const exit = await supervise(s, {
      isBusy: async () => true,
      interrupt: () => new Promise<void>(() => {}),
    });
    expect(exit?.reason).toBe("wall-timeout");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("gives an interrupted worker the kill grace to end on its own, and sends no signal when it does", async () => {
    const s = spec(`while [ ! -f stop ]; do sleep 0.02; done; exit 7`, { idleMs: 100, killGraceMs: 10_000 });
    const t0 = Date.now();
    const exit = await supervise(s, {
      interrupt: async () => writeFileSync(join(s.dispatchDir, "stop"), ""),
    });
    expect(exit).toMatchObject({ code: 7, signal: null, reason: "idle-timeout" });
    // it ended when the worker did, not when the grace ran out
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("supervise follows the worker's own account", () => {
  it("keeps a run with a tool call open busy, however quiet, and idles it once the call closes", async () => {
    const s = spec("echo open; sleep 0.5; echo close; sleep 30", { idleMs: 100 });
    const seen: string[] = [];
    const exit = await supervise(s, {
      onLine: (l) => {
        seen.push(l);
        return l === "open" || l === "close" ? { item: { id: "item_1", open: l === "open" } } : {};
      },
    });
    expect(exit?.reason).toBe("idle-timeout");
    // the idle limit (100 ms) passed five times while the call was open, and the run lived on
    expect(seen).toEqual(["open", "close"]);
  });

  it("asks isBusy with the time the run started", async () => {
    const t0 = Date.now();
    let since = 0;
    await supervise(spec("sleep 30", { idleMs: 100 }), {
      isBusy: async (_thread, sinceMs) => {
        since = sinceMs;
        return false;
      },
    });
    expect(since).toBeGreaterThanOrEqual(t0);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it("records a worker that ended on its own as exited, though a cancel arrived after it ended", async () => {
    const s = spec("exit 5", { pollMs: 200 });
    const running = supervise(s);
    const proc = dispatchPaths(s.dispatchDir).proc;
    const { pid } = await waitFor(
      () => existsSync(proc) && (JSON.parse(readFileSync(proc, "utf8")) as { pid: number }),
    );
    // reaped: this process runs the supervisor, so its exit is already known to it
    await waitFor(() => gone(pid));
    requestCancel(s.dispatchDir);
    expect(await running).toMatchObject({ code: 5, signal: null, reason: "exited" });
  });

  it("records a worker that ended while isBusy was being asked as exited, not idle-timeout", async () => {
    // the busy check is bounded by min(10s, idleMs): leave the worker a full second to see `stop` and end, or a
    // slow runner times the check out and the worker is stopped as idle before it can exit on its own
    const s = spec(`while [ ! -f stop ]; do sleep 0.02; done; exit 4`, { idleMs: 1000 });
    const proc = dispatchPaths(s.dispatchDir).proc;
    const exit = await supervise(s, {
      isBusy: async () => {
        const { pid } = JSON.parse(readFileSync(proc, "utf8")) as { pid: number };
        writeFileSync(join(s.dispatchDir, "stop"), "");
        // answer "not busy" only once the worker has ended on its own
        await waitFor(() => gone(pid));
        return false;
      },
    });
    expect(exit).toMatchObject({ code: 4, signal: null, reason: "exited" });
    expect(readExit(s.dispatchDir)?.reason).toBe("exited");
  });
});

/** True once `pid` no longer exists at all (reaped). */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

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
    expect(exit?.reason).toBe("cancelled");
    expect(member).toBeGreaterThan(0);
    expect(readFileSync(events, "utf8").trim()).toBe(String(member));
    await waitFor(() => exited(member), 5_000);
  });

  it("kills a group member left behind when the worker exits on its own", async () => {
    const s = spec(`sleep 30 & echo $!; exit 0`);
    const events = dispatchPaths(s.dispatchDir).events;
    const exit = await supervise(s);
    const member = Number(readFileSync(events, "utf8").trim());
    expect(member).toBeGreaterThan(0);
    expect(exit).toMatchObject({ code: 0, signal: null, reason: "exited" });
    expect(readExit(s.dispatchDir)).toMatchObject({ code: 0, reason: "exited" });
    await waitFor(() => exited(member), 5_000);
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

describe("one supervisor per dispatch (codex P2: a relaunch between spawn and launch.json)", () => {
  it("lets a second supervisor for a live one's dispatch exit at once, touching nothing", async () => {
    const release = join(tempDir("catherd-hold-"), "release");
    const s = spec(`echo '{"type":"first"}'; while [ ! -f '${release}' ]; do sleep 0.02; done`);
    const p = dispatchPaths(s.dispatchDir);
    const first = supervise(s);
    await waitFor(() => existsSync(p.proc) && readFileSync(p.events, "utf8").length > 0);
    const events = readFileSync(p.events, "utf8");
    const proc = readFileSync(p.proc, "utf8");
    expect(await supervise({ ...s, args: ["-c", "echo second"] })).toBeNull();
    expect(readFileSync(p.events, "utf8")).toBe(events);
    expect(readFileSync(p.proc, "utf8")).toBe(proc);
    expect(readExit(s.dispatchDir)).toBeNull();
    writeFileSync(release, "");
    expect(await first).toMatchObject({ reason: "exited" });
    // released on exit: a later supervisor may run the dispatch again
    expect(existsSync(p.supervisorLock)).toBe(false);
  });

  it("takes over the lock of a supervisor that died", async () => {
    const s = spec("exit 0");
    const p = dispatchPaths(s.dispatchDir);
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(p.supervisorLock, JSON.stringify({ pid: dead.pid, startTime: "gone" }));
    expect(await supervise(s)).toMatchObject({ reason: "exited", code: 0 });
  });
});

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";

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
    expect(JSON.parse(readFileSync(p.proc, "utf8"))).toMatchObject({ schema: 1, pid: expect.any(Number) });
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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { launchSupervisor } from "../../src/infra/launch.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());
// the supervisor and launchSupervisor log (spec §10.2): keep their rows out of the real data dir
beforeEach(() => void withHome());

async function until<T>(f: () => T | null | false, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) return null;
    await Bun.sleep(25);
  }
}

describe("supervise-bin", () => {
  it("exits as soon as exit.json is written, even with a hook's call still pending", async () => {
    // Every `opencode api` call hangs for 30 s: the idle check and the interrupt are cut off by the
    // supervisor, but their child processes and timers would keep a supervisor that just returned alive.
    process.env.PATH = simPath();
    Object.assign(process.env, withOpencodeScenario({ apiHangMs: 30_000, active: {} }).env);
    const dir = mkdtempSync(join(tmpdir(), "catherd-supbin-"));
    const p = dispatchPaths(dir);
    writeFileSync(p.brief, "x");
    writeJsonAtomic(p.spec, {
      schema: 1,
      backend: "opencode",
      dispatchDir: dir,
      cmd: "sh",
      args: ["-c", `echo '{"type":"step_start","sessionID":"ses_f2671cde4ffe4VbeG6dKWzM2vi"}'; sleep 30`],
      env: { PATH: process.env.PATH ?? "", CATHERD_SIM_OPENCODE: process.env.CATHERD_SIM_OPENCODE ?? "" },
      cwd: dir,
      stdinPath: null,
      idleMs: 300,
      wallMs: 60_000,
      killGraceMs: 200,
      graceAfterFinalMs: null,
      pollMs: 20,
    });
    const pid = launchSupervisor(p.spec);
    const exit = await until(() => readExit(dir), 20_000);
    expect(exit?.reason).toBe("idle-timeout");
    const proc = JSON.parse(readFileSync(p.proc, "utf8")) as { supervisorStartTime: string | null };
    expect(await until(() => !isAlive(pid, proc.supervisorStartTime), 3_000)).toBe(true);
  }, 30_000);
});

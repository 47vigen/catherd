import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { launchSupervisor } from "../../src/infra/launch.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";

async function waitFor<T>(f: () => T | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

describe("launchSupervisor", () => {
  it("returns immediately, and the detached supervisor still writes exit.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-launch-"));
    const spec = join(dir, "spec.json");
    writeJsonAtomic(spec, {
      schema: 1,
      backend: "none",
      dispatchDir: dir,
      cmd: "sh",
      args: ["-c", "sleep 0.3; echo done"],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      stdinPath: null,
      idleMs: 5000,
      wallMs: 10000,
      killGraceMs: 200,
      graceAfterFinalMs: null,
      pollMs: 20,
    });
    const t0 = Date.now();
    const pid = launchSupervisor(spec);
    expect(pid).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(250);
    const exit = await waitFor(() => readExit(dir));
    expect(exit).toMatchObject({ code: 0, reason: "exited" });
    expect(await Bun.file(dispatchPaths(dir).events).text()).toBe("done\n");
  });
});

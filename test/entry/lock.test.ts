import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSlots } from "../../src/entry/lock.ts";
import { heavySlots } from "../../src/infra/heavy-lock.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd lock", () => {
  it("takes --slots, then CATHERD_LOCK_SLOTS, then the profile, then half the cores", () => {
    delete process.env.CATHERD_LOCK_SLOTS;
    expect(resolveSlots("3", () => 1)).toBe(3);
    process.env.CATHERD_LOCK_SLOTS = "2";
    expect(resolveSlots(undefined, () => 1)).toBe(2);
    delete process.env.CATHERD_LOCK_SLOTS;
    expect(resolveSlots(undefined, () => 4)).toBe(4);
    expect(
      resolveSlots(undefined, () => {
        throw new Error("no profile");
      }),
    ).toBe(heavySlots("cpus/2"));
    expect(() => resolveSlots("zero", () => 1)).toThrow(/slots/);
  });

  it("runs the command behind a slot and passes its exit code through", () => {
    const home = withHome();
    const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "sh", "-c", "exit 7"], {
      env: { ...process.env, CATHERD_HOME: home },
    });
    expect(p.exitCode).toBe(7);
  });

  it("warns when it falls back to half the cores because the profile cannot be read", () => {
    const warned: string[] = [];
    const slots = resolveSlots(
      undefined,
      () => {
        throw new Error("config.json is from catherd 0.x");
      },
      (m) => warned.push(m),
    );
    expect(warned).toEqual([
      `catherd lock: no profile to read lock.heavy from (config.json is from catherd 0.x); using ${slots} slots`,
    ]);
  });

  it("refuses a bad --slots as a usage error", () => {
    withHome();
    const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "zero", "--", "true"], {
      env: process.env,
      stderr: "pipe",
    });
    expect([p.exitCode, p.stderr.toString().split("\n")[0]]).toEqual([
      2,
      'error E_INPUT_INVALID: slots must be a number ≥ 1 or cpus/2, not "zero"',
    ]);
  });

  it("passes catherd's --verbose to the command as CATHERD_LOG", () => {
    withHome();
    const p = Bun.spawnSync(
      [process.execPath, CLI, "--verbose", "lock", "--slots", "1", "--", "sh", "-c", "echo $CATHERD_LOG"],
      { env: process.env, stdout: "pipe" },
    );
    expect(p.stdout.toString()).toBe("debug\n");
  });
});

describe("catherd lock signals (plan-2 review m10)", () => {
  /** Starts `catherd lock -- sh -c <script>` and waits for the script to write its background child's pid. */
  async function locked(script: string) {
    const home = withHome();
    const pidFile = join(mkdtempSync(join(tmpdir(), "catherd-lockpid-")), "pid");
    const p = Bun.spawn(
      [process.execPath, CLI, "lock", "--slots", "1", "--", "sh", "-c", script.replace("PIDFILE", pidFile)],
      {
        env: { ...process.env, CATHERD_HOME: home },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
    return { p, grandchild: Number(readFileSync(pidFile, "utf8")) };
  }

  for (const sig of ["SIGTERM", "SIGHUP"] as const)
    it(`forwards ${sig} to the command's whole process group`, async () => {
      const { p, grandchild } = await locked("sleep 30 & echo $! > PIDFILE; wait");
      p.kill(sig);
      expect(await p.exited).toBe(128 + (sig === "SIGTERM" ? 15 : 1));
      await waitFor(() => !isAlive(grandchild, null));
    });

  it("kills a command that ignores Ctrl-C on the second Ctrl-C", async () => {
    const { p } = await locked("trap '' INT; echo $$ > PIDFILE; while :; do sleep 0.1; done");
    p.kill("SIGINT");
    await Bun.sleep(200);
    p.kill("SIGINT");
    expect(await p.exited).toBe(137);
  });
});

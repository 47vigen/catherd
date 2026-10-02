import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSlots, roleLockOwnerOf } from "../../src/entry/lock-command.ts";
import { tryLock } from "../../src/infra/filelock.ts";
import { heavySlots } from "../../src/infra/heavy-lock.ts";
import { activityDir } from "../../src/infra/lock-activity.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { killGroup } from "../../src/infra/proc.ts";
import { exited, snapshotEnv, withHome } from "../helpers.ts";
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

  it("shares a verifier lock by run: --run, else the run in CATHERD_ROLE, else this process alone", () => {
    expect(roleLockOwnerOf("r1", { CATHERD_ROLE: "r2/verifier-M1" })).toBe("run:r1");
    expect(roleLockOwnerOf(undefined, { CATHERD_ROLE: "r2/verifier-M1" })).toBe("run:r2");
    expect(roleLockOwnerOf(undefined, {})).toBe(`process:${process.pid}`);
  });

  it("runs a --role verifier command holding the verifier lock, and refuses an unknown role", () => {
    const home = withHome();
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", ...args], {
        env: { ...process.env, CATHERD_HOME: home, ANTHROPIC_API_KEY: "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
    const held = run([
      "--role",
      "verifier",
      "--run",
      "r1",
      "--",
      "sh",
      "-c",
      'echo "held=$CATHERD_LOCK_HELD"',
    ]);
    expect(held.exitCode).toBe(0);
    expect(held.stdout.toString()).toBe("held=1\n");
    const unknown = run(["--role", "reviewer", "--", "true"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr.toString()).toContain('no role lock "reviewer"');
  });

  it("runs a lock nested in a locked command at once, even with every slot taken", () => {
    const home = withHome();
    mkdirSync(locksDir(), { recursive: true });
    const release = tryLock(join(locksDir(), "slot-0"));
    try {
      const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "echo", "nested"], {
        env: { ...process.env, CATHERD_HOME: home, ANTHROPIC_API_KEY: "", CATHERD_LOCK_HELD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(p.stdout.toString()).toBe("nested\n");
    } finally {
      release?.();
    }
  });

  it("keeps catherd's own secret out of the command's environment (SECURITY.md)", () => {
    const home = withHome();
    const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "1", "--", "env"], {
      env: {
        ...process.env,
        CATHERD_HOME: home,
        TYPESAFE_API_KEY: "tsk_FAKEKEY_DO_NOT_USE_1234567890",
        CATHERD_TEST_KEEP: "kept",
      },
      stdout: "pipe",
    });
    const out = p.stdout.toString();
    expect(p.exitCode).toBe(0);
    expect(out).not.toContain("TYPESAFE_API_KEY");
    expect(out).not.toContain("FAKEKEY");
    expect(out).toContain("CATHERD_TEST_KEEP=kept");
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

  it("inside a dispatch, passes the output through and reports it while the command runs (plan 23)", () => {
    withHome();
    const dir = activityDir("01TESTDISPATCH");
    const p = Bun.spawnSync(
      [
        process.execPath,
        CLI,
        "lock",
        "--slots",
        "1",
        "--",
        "sh",
        "-c",
        'echo out; echo err 1>&2; ls "$1"',
        "_",
        dir,
      ],
      { env: { ...process.env, CATHERD_DISPATCH_ID: "01TESTDISPATCH" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(p.exitCode).toBe(0);
    const [first, listed] = p.stdout.toString().split("\n");
    expect(first).toBe("out");
    expect(listed).toMatch(/^\d+\.json$/);
    expect(p.stderr.toString()).toBe("err\n");
    // gone once the lock ends: a finished lock never keeps a role's wall alive
    expect(readdirSync(dir)).toEqual([]);
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
      await waitFor(() => exited(grandchild));
    });

  it("kills the command's group when catherd itself is killed outright", async () => {
    const { p, grandchild } = await locked("sleep 30 & echo $! > PIDFILE; wait");
    p.kill("SIGKILL");
    await p.exited;
    await waitFor(() => exited(grandchild));
  });

  it("kills a command that ignores Ctrl-C on the second Ctrl-C", async () => {
    const heard = join(mkdtempSync(join(tmpdir(), "catherd-lockint-")), "heard");
    // the trap records each Ctrl-C and carries on, as a command that ignores it would
    const { p, grandchild } = await locked(
      `trap 'echo INT >> ${heard}' INT; echo $$ > PIDFILE; while :; do sleep 0.1; done`,
    );
    try {
      p.kill("SIGINT");
      // the second Ctrl-C only once the first reached the command: two signals sent at once may merge into one
      await waitFor(() => existsSync(heard), 5_000);
      p.kill("SIGINT");
      expect(await p.exited).toBe(137);
    } finally {
      killGroup(grandchild, "SIGKILL");
    }
  }, 15_000);
});

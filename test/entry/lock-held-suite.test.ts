import { expect, it } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

// plan 52: a check runs this suite under `catherd lock`, which sets CATHERD_LOCK_HELD=1 for its command; the lock
// tests must pass there as they do outside a lock
it("the lock tests pass inside a locked command", () => {
  const p = Bun.spawnSync(
    [process.execPath, "test", "test/entry/lock-command.test.ts", "test/infra/heavy-lock.test.ts"],
    {
      cwd: ROOT,
      env: { ...process.env, CATHERD_LOCK_HELD: "1", ANTHROPIC_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = `${p.stdout.toString()}${p.stderr.toString()}`;
  expect(out).toContain(" 0 fail");
  expect(p.exitCode).toBe(0);
}, 120_000);

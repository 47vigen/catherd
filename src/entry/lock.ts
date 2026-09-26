import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { gitToplevel } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { killGroup } from "../infra/proc.ts";
import { profileFor } from "../services/profile-service.ts";
import { printError } from "./cli-kit.ts";

/**
 * --slots, then CATHERD_LOCK_SLOTS, then the profile's lock.heavy, then half the cores. `warn` hears why
 * the profile could not say, so the fallback is never silent (plan-2 review m10).
 */
export function resolveSlots(
  flag: string | undefined,
  profile: () => number | "cpus/2",
  warn: (message: string) => void = () => {},
): number {
  const raw = flag ?? process.env.CATHERD_LOCK_SLOTS;
  if (raw) {
    if (raw === "cpus/2") return heavySlots("cpus/2");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1)
      throw new CatherdError("E_INPUT_INVALID", `slots must be a number ≥ 1 or cpus/2, not "${raw}"`, {
        fix: "catherd lock --slots 2 -- <command>",
      });
    return heavySlots(n);
  }
  try {
    return heavySlots(profile());
  } catch (e) {
    const slots = heavySlots("cpus/2");
    warn(`catherd lock: no profile to read lock.heavy from (${(e as Error).message}); using ${slots} slots`);
    return slots;
  }
}

/** How long a second Ctrl-C has to follow the first to kill the command outright. */
export const DOUBLE_INTERRUPT_MS = 2_000;

/**
 * Runs `argv` in its own process group and forwards SIGINT, SIGTERM and SIGHUP to the whole group once:
 * a terminal's Ctrl-C reaches catherd only, so the command sees it exactly once, and so does every
 * process it started. A second Ctrl-C within 2 s kills the group. Resolves to the command's exit code.
 */
export async function runForwarding(argv: string[]): Promise<number> {
  const child = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    detached: true,
  });
  let lastInt = 0;
  const handlers: [NodeJS.Signals, () => void][] = [
    [
      "SIGINT",
      () => {
        const now = Date.now();
        killGroup(child.pid, now - lastInt < DOUBLE_INTERRUPT_MS ? "SIGKILL" : "SIGINT");
        lastInt = now;
      },
    ],
    ["SIGTERM", () => killGroup(child.pid, "SIGTERM")],
    ["SIGHUP", () => killGroup(child.pid, "SIGHUP")],
  ];
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    return await child.exited;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

export const lockCommand = defineCommand({
  meta: { name: "lock", description: "Run a heavy command behind the machine-wide semaphore" },
  args: {
    slots: {
      type: "string",
      description: "Slots (default: CATHERD_LOCK_SLOTS, else the profile's lock.heavy, else half the cores)",
    },
  },
  async run({ args, rawArgs }) {
    const sep = rawArgs.indexOf("--");
    const argv = sep < 0 ? [] : rawArgs.slice(sep + 1);
    if (argv.length === 0) {
      printError(
        new CatherdError("E_INPUT_INVALID", "no command to run", {
          fix: "catherd lock [--slots N] -- <command> [args...]",
        }),
      );
      process.exitCode = 2;
      return;
    }
    const repo = await gitToplevel(process.cwd());
    const slots = resolveSlots(
      args.slots,
      () => profileFor(repo).lock.heavy,
      (m) => console.error(m),
    );
    process.exitCode = await withHeavySlot(slots, () => runForwarding(argv));
  },
});

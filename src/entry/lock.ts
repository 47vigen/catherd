import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { profileFor } from "../services/profile-service.ts";

/** --slots, then CATHERD_LOCK_SLOTS, then the active profile's lock.heavy, then half the cores. */
export function resolveSlots(flag: string | undefined, profile: () => number | "cpus/2"): number {
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
  } catch {
    return heavySlots("cpus/2");
  }
}

export const lockCommand = defineCommand({
  meta: { name: "lock", description: "Run a heavy command behind the machine-wide semaphore" },
  args: {
    slots: {
      type: "string",
      description: "Slots (default: CATHERD_LOCK_SLOTS, else lock.heavy, else half the cores)",
    },
  },
  async run({ args, rawArgs }) {
    const sep = rawArgs.indexOf("--");
    const [cmd, ...rest] = sep < 0 ? [] : rawArgs.slice(sep + 1);
    if (!cmd) {
      console.error("usage: catherd lock [--slots N] -- <command> [args...]");
      process.exitCode = 2;
      return;
    }
    let slots: number;
    try {
      slots = resolveSlots(args.slots, () => profileFor(null).lock.heavy);
    } catch (e) {
      console.error(`error ${(e as CatherdError).code}: ${(e as Error).message}`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await withHeavySlot(slots, async () => {
      const child = Bun.spawn([cmd, ...rest], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
      const onInt = forward("SIGINT");
      const onTerm = forward("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      try {
        return await child.exited;
      } finally {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
      }
    }).catch((e: unknown) => {
      console.error(`catherd lock: ${(e as Error).message}`);
      return 1;
    });
  },
});

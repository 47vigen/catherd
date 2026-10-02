import { HOST_ARG } from "./host-arg.ts";
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { scrubSecrets } from "../infra/env.ts";
import { gitToplevel } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { activityReporter, DISPATCH_ID_ENV } from "../infra/lock-activity.ts";
import { killGroup } from "../infra/proc.ts";
import { activeName, readProfileDoc } from "../services/profile-store.ts";
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
export async function runForwarding(argv: string[], o: { onOutput?: () => void } = {}): Promise<number> {
  // plan 23: inside a dispatch the output passes through catherd, which notes when the command last wrote
  const piped = o.onOutput !== undefined;
  const child = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: piped ? "pipe" : "inherit",
    stderr: piped ? "pipe" : "inherit",
    env: scrubSecrets(process.env),
    detached: true,
  });
  const pumps =
    piped && o.onOutput
      ? [
          pump(child.stdout as ReadableStream<Uint8Array>, process.stdout, o.onOutput),
          pump(child.stderr as ReadableStream<Uint8Array>, process.stderr, o.onOutput),
        ]
      : [];
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
  // The command's own session is out of reach of a signal to catherd's group, and a SIGKILL (a
  // supervisor's escalation) cannot be forwarded: the watchdog reads EOF when catherd dies, however it
  // dies, and kills the command's group then.
  const watchdog = Bun.spawn(
    ["sh", "-c", 'read _ || kill -s KILL -- "-$1" 2>/dev/null', "sh", String(child.pid)],
    {
      env: scrubSecrets(process.env),
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
  try {
    const code = await child.exited;
    // a process the command left behind may hold the pipes open: what it wrote by then is passed on
    await Promise.race([Promise.all(pumps), Bun.sleep(PIPE_DRAIN_MS)]);
    return code;
  } finally {
    watchdog.kill("SIGKILL");
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

/** How long the pipes may stay open after the command exits. */
const PIPE_DRAIN_MS = 500;

/** Copies a piped stream to `out`, calling `tick` for each chunk; a broken pipe ends the copy. */
async function pump(
  stream: ReadableStream<Uint8Array>,
  out: NodeJS.WriteStream,
  tick: () => void,
): Promise<void> {
  try {
    for await (const chunk of stream) {
      out.write(chunk);
      tick();
    }
  } catch {
    // the command's end closes the pipe
  }
}

/** Spec §8: what `--help` and the usage error show; the command runs after `--`. */
export const LOCK_USAGE = "catherd lock [--slots N] -- <command> [args...]";

export const lockCommand = defineCommand({
  meta: {
    name: "lock",
    description:
      "Run a heavy command behind the machine-wide semaphore, in its own process group and session: it gets no /dev/tty and no job control",
  },
  args: {
    ...HOST_ARG,
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
          fix: LOCK_USAGE,
        }),
      );
      process.exitCode = 2;
      return;
    }
    const repo = await gitToplevel(process.cwd());
    const slots = resolveSlots(
      args.slots,
      // lock.heavy is host-independent: read it stored, so a worker (whose host identity is scrubbed) and an
      // unknown terminal host still get the profile's value instead of the cpus/2 fallback
      () => readProfileDoc(activeName(repo)).lock?.heavy ?? "cpus/2",
      (m) => console.error(m),
    );
    process.exitCode = await withHeavySlot(slots, async () => {
      // plan 23: a role's lock reports its output, so the role's wall timeout counts from its last line
      const activity = activityReporter(process.env[DISPATCH_ID_ENV]);
      try {
        return await runForwarding(argv, activity ? { onOutput: activity.tick } : {});
      } finally {
        activity?.done();
      }
    });
  },
});

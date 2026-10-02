import { defineCommand } from "citty";
import { adapterFor } from "../adapters/registry.ts";
import { workerEnv } from "../infra/env.ts";
import { log } from "../infra/log.ts";
import { loginEnv } from "../infra/login-env.ts";
import { readVersioned } from "../infra/store.ts";
import { SuperviseSpecSchema, supervise } from "../infra/supervisor.ts";
import { resolveRefs } from "../services/gate-env.ts";
import "../adapters/all.ts";

/**
 * Supervises the worker a spec file describes, with its backend's hooks, until exit.json is written.
 * spec.json holds only the adapter's env overrides; the worker's env is built here, from this process's
 * own inherited env (already without catherd's secrets), so no credential is ever on disk (spec §10.4).
 */
/**
 * The worker's env: this process's env, the gate env's references (plan 23: read here from this env, else the
 * login env), then the spec's own env last, so no reference ever takes the role's identity, scratch or home.
 */
export function superviseEnv(
  read: { env: Record<string, string>; envFrom?: Record<string, string>; cwd: string; dispatchDir?: string },
  base: Record<string, string | undefined>,
  login: () => Record<string, string | undefined>,
): Record<string, string> {
  const refs = resolveRefs({}, read.envFrom ?? {}, base, login);
  if (refs.missing.length) log("warn", "gate-env", { dispatch: read.dispatchDir, unset: refs.missing });
  return workerEnv(base, { ...refs.env, ...read.env }, read.cwd);
}

export async function runSupervise(specPath: string): Promise<void> {
  const read = readVersioned(specPath, SuperviseSpecSchema, 1);
  const spec = { ...read, env: superviseEnv(read, process.env, loginEnv) };
  const a = adapterFor(spec.backend);
  const busy = a?.isBusy?.bind(a);
  const stop = a?.interrupt?.bind(a);
  const retrying = a?.providerRetry?.bind(a);
  const ended = await supervise(spec, {
    onLine: (line) => {
      const d = a?.parse(line) ?? {};
      return { final: d.final, thread: d.thread, item: d.item, step: d.step };
    },
    isBusy: busy
      ? (thread, sinceMs) => (thread ? busy(thread, spec.cwd, sinceMs) : Promise.resolve(false))
      : undefined,
    interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
    providerRetry: retrying
      ? (thread, sinceMs) => (thread ? retrying(thread, spec.cwd, sinceMs) : Promise.resolve(null))
      : undefined,
  });
  // plan 22: a Codex owner hears of the role from here too, when its thread's MCP server is gone. Loaded only
  // once the worker ended (a supervisor that lost the lock to another pushes nothing); never throws.
  if (ended && process.env.CATHERD_NO_END_PUSH !== "1") {
    const { pushFromEnd } = await import("../services/end-push.ts");
    await pushFromEnd(spec.dispatchDir);
  }
}

export const superviseCommand = defineCommand({
  meta: { name: "_supervise", description: "internal: supervise one worker process", hidden: true },
  args: { spec: { type: "positional", required: true } },
  async run({ args }) {
    await runSupervise(args.spec);
  },
});

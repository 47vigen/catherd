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
export async function runSupervise(specPath: string): Promise<void> {
  const read = readVersioned(specPath, SuperviseSpecSchema, 1);
  // plan 23: a gate env secret by reference, read here from this env, else the user's login env
  const refs = resolveRefs({}, read.envFrom ?? {}, process.env, loginEnv);
  if (refs.missing.length) log("warn", "gate-env", { dispatch: read.dispatchDir, unset: refs.missing });
  const spec = { ...read, env: workerEnv(process.env, { ...read.env, ...refs.env }, read.cwd) };
  const a = adapterFor(spec.backend);
  const busy = a?.isBusy?.bind(a);
  const stop = a?.interrupt?.bind(a);
  const ended = await supervise(spec, {
    onLine: (line) => {
      const d = a?.parse(line) ?? {};
      return { final: d.final, thread: d.thread, item: d.item };
    },
    isBusy: busy
      ? (thread, sinceMs) => (thread ? busy(thread, spec.cwd, sinceMs) : Promise.resolve(false))
      : undefined,
    interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
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

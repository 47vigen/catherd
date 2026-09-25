import { defineCommand } from "citty";
import { adapterFor } from "../adapters/registry.ts";
import { workerEnv } from "../infra/env.ts";
import { readVersioned } from "../infra/store.ts";
import { SuperviseSpecSchema, supervise } from "../infra/supervisor.ts";
import "../adapters/all.ts";

/**
 * Supervises the worker a spec file describes, with its backend's hooks, until exit.json is written.
 * spec.json holds only the adapter's env overrides; the worker's env is built here, from this process's
 * own inherited env (already without catherd's secrets), so no credential is ever on disk (spec §10.4).
 */
export async function runSupervise(specPath: string): Promise<void> {
  const read = readVersioned(specPath, SuperviseSpecSchema, 1);
  const spec = { ...read, env: workerEnv(process.env, read.env, read.cwd) };
  const a = adapterFor(spec.backend);
  const busy = a?.isBusy?.bind(a);
  const stop = a?.interrupt?.bind(a);
  await supervise(spec, {
    onLine: (line) => {
      const d = a?.parse(line) ?? {};
      return { final: d.final, thread: d.thread };
    },
    isBusy: busy ? (thread) => (thread ? busy(thread, spec.cwd) : Promise.resolve(false)) : undefined,
    interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
  });
}

export const superviseCommand = defineCommand({
  meta: { name: "_supervise", description: "internal: supervise one worker process" },
  args: { spec: { type: "positional", required: true } },
  async run({ args }) {
    await runSupervise(args.spec);
  },
});

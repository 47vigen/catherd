import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { z } from "zod";
import type { ExitInfo, ExitReason } from "../domain/record.ts";
import { dispatchPaths } from "./dispatch-dir.ts";
import { killGroup, processStartTime } from "./proc.ts";
import { writeJsonAtomic } from "./store.ts";

export const SuperviseSpecSchema = z.looseObject({
  schema: z.literal(1),
  backend: z.string(),
  dispatchDir: z.string(),
  cmd: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string(),
  stdinPath: z.string().nullable(),
  idleMs: z.number().positive(),
  wallMs: z.number().positive(),
  killGraceMs: z.number().nonnegative(),
  graceAfterFinalMs: z.number().nonnegative().nullable(),
  pollMs: z.number().positive(),
});
export type SuperviseSpec = z.infer<typeof SuperviseSpecSchema>;

export interface SuperviseHooks {
  onLine?(line: string): { final?: boolean; thread?: string };
  isBusy?(thread: string | null): Promise<boolean>;
  interrupt?(thread: string | null): Promise<void>;
}

/** Reads whatever the child appended to `file` since `offset`, as complete lines. */
function readNew(file: string, state: { offset: number; rest: string }): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (size <= state.offset) return [];
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - state.offset);
    readSync(fd, buf, 0, buf.length, state.offset);
    state.offset = size;
    const text = state.rest + buf.toString("utf8");
    const lines = text.split("\n");
    state.rest = lines.pop() ?? "";
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

export async function supervise(spec: SuperviseSpec, hooks: SuperviseHooks = {}): Promise<ExitInfo> {
  const p = dispatchPaths(spec.dispatchDir);
  const stdin = spec.stdinPath ? openSync(spec.stdinPath, "r") : "ignore";
  const stdout = openSync(p.events, "w");
  const stderr = openSync(p.stderr, "w");
  const child = Bun.spawn([spec.cmd, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdin,
    stdout,
    stderr,
    detached: true,
  });
  for (const fd of [stdin, stdout, stderr]) if (typeof fd === "number") closeSync(fd);
  writeJsonAtomic(p.proc, {
    schema: 1,
    pid: child.pid,
    startTime: processStartTime(child.pid),
    supervisorPid: process.pid,
    supervisorStartTime: processStartTime(process.pid),
    startedAt: new Date().toISOString(),
  });

  const started = Date.now();
  let lastActivity = started;
  let finalAt: number | null = null;
  let thread: string | null = null;
  let reason: ExitReason | null = null;
  let done = false;
  const stream = { offset: 0, rest: "" };
  void child.exited.then(() => {
    done = true;
  });

  while (!done && reason === null) {
    await Bun.sleep(spec.pollMs);
    const lines = readNew(p.events, stream);
    if (lines.length) lastActivity = Date.now();
    for (const line of lines) {
      const d = hooks.onLine?.(line);
      if (d?.thread) thread = d.thread;
      if (d?.final) finalAt ??= Date.now();
    }
    const now = Date.now();
    if (existsSync(p.cancel)) reason = "cancelled";
    else if (now - started >= spec.wallMs) reason = "wall-timeout";
    else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
      reason = "after-final";
    else if (now - lastActivity >= spec.idleMs) {
      if (hooks.isBusy && (await hooks.isBusy(thread))) lastActivity = Date.now();
      else reason = "idle-timeout";
    }
  }

  if (reason !== null && !done) {
    if (reason !== "after-final") await hooks.interrupt?.(thread).catch(() => undefined);
    killGroup(child.pid, "SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(spec.killGraceMs).then(() => false),
    ]);
    if (!exited) killGroup(child.pid, "SIGKILL");
  }
  const code = await child.exited;
  const info: ExitInfo = {
    code: child.signalCode ? null : code,
    signal: child.signalCode ?? null,
    reason: reason ?? "exited",
    endedAt: new Date().toISOString(),
  };
  writeJsonAtomic(p.exit, { schema: 1, ...info });
  return info;
}

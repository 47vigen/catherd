import type { Subprocess } from "bun";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
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
function readNew(file: string, state: { offset: number; rest: string; decoder: TextDecoder }): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (size <= state.offset) return [];
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - state.offset);
    readSync(fd, buf, 0, buf.length, state.offset);
    state.offset = size;
    // stream: a multi-byte character split across two polls waits in the decoder for its tail.
    const text = state.rest + state.decoder.decode(buf, { stream: true });
    const lines = text.split("\n");
    state.rest = lines.pop() ?? "";
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

/** A hook's answer, or `fallback` when it throws, rejects or takes longer than `ms`. */
async function bounded<T>(call: () => Promise<T> | undefined, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = call();
    if (!answer) return fallback;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    });
    return await Promise.race([answer, late]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM the group, give it `graceMs` to leave, then SIGKILL whatever is left of it. */
async function stopGroup(pgid: number, graceMs: number, pollMs: number): Promise<void> {
  killGroup(pgid, "SIGTERM");
  const end = Date.now() + graceMs;
  while (Date.now() < end && groupAlive(pgid))
    await Bun.sleep(Math.max(1, Math.min(pollMs, end - Date.now())));
  // Always, not only when the leader lingers: a member that ignores SIGTERM outlives its leader.
  // The group only, never the bare pid: once the leader is gone its pid may belong to someone else.
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // the group is gone
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function supervise(spec: SuperviseSpec, hooks: SuperviseHooks = {}): Promise<ExitInfo> {
  const p = dispatchPaths(spec.dispatchDir);
  const finish = (info: ExitInfo): ExitInfo => {
    writeJsonAtomic(p.exit, { schema: 1, ...info });
    return info;
  };
  const fds: number[] = [];
  let child: Subprocess;
  try {
    const stdin = spec.stdinPath ? openSync(spec.stdinPath, "r") : "ignore";
    if (typeof stdin === "number") fds.push(stdin);
    const stdout = openSync(p.events, "w");
    fds.push(stdout);
    const stderr = openSync(p.stderr, "w");
    fds.push(stderr);
    child = Bun.spawn([spec.cmd, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdin,
      stdout,
      stderr,
      detached: true,
    });
  } catch (e) {
    try {
      appendFileSync(p.stderr, `catherd: could not start ${spec.cmd}: ${message(e)}\n`);
    } catch {
      // exit.json below still records that the worker never ran
    }
    return finish({ code: null, signal: null, reason: "lost", endedAt: new Date().toISOString() });
  } finally {
    for (const fd of fds) closeSync(fd);
  }

  const hookMs = Math.min(10_000, spec.idleMs);
  let reason: ExitReason | null = null;
  let thread: string | null = null;
  let failure: { error: unknown } | null = null;
  let done = false;
  void child.exited.then(() => {
    done = true;
  });

  try {
    writeJsonAtomic(p.proc, {
      schema: 1,
      pid: child.pid,
      pgid: child.pid, // the detached child leads its own group
      startTime: processStartTime(child.pid),
      supervisorPid: process.pid,
      supervisorStartTime: processStartTime(process.pid),
      startedAt: new Date().toISOString(),
    });

    const started = Date.now();
    let lastActivity = started;
    let finalAt: number | null = null;
    const stream = { offset: 0, rest: "", decoder: new TextDecoder("utf-8") };

    while (!done && reason === null) {
      await Bun.sleep(spec.pollMs);
      const lines = readNew(p.events, stream);
      if (lines.length) lastActivity = Date.now();
      for (const line of lines) {
        let d: { final?: boolean; thread?: string } | undefined;
        try {
          d = hooks.onLine?.(line);
        } catch {
          continue; // one line the hook cannot read must not end supervision
        }
        if (d?.thread) thread = d.thread;
        if (d?.final) finalAt ??= Date.now();
      }
      const now = Date.now();
      if (existsSync(p.cancel)) reason = "cancelled";
      else if (now - started >= spec.wallMs) reason = "wall-timeout";
      else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
        reason = "after-final";
      else if (now - lastActivity >= spec.idleMs) {
        if (await bounded(() => hooks.isBusy?.(thread), hookMs, false)) lastActivity = Date.now();
        else reason = "idle-timeout";
      }
    }
  } catch (e) {
    failure = { error: e };
    reason = "lost";
  }

  let stopped = false;
  if (reason !== null && !done) {
    if (reason !== "after-final" && failure === null)
      await bounded(() => hooks.interrupt?.(thread), hookMs, undefined);
    if (!done) {
      await stopGroup(child.pid, spec.killGraceMs, spec.pollMs);
      stopped = true;
    }
  }
  const code = await child.exited;
  // On every path: a worker that ends on its own may leave members of its group behind.
  if (!stopped && groupAlive(child.pid)) await stopGroup(child.pid, spec.killGraceMs, spec.pollMs);
  const info = finish({
    code: child.signalCode ? null : code,
    signal: child.signalCode ?? null,
    reason: reason ?? "exited",
    endedAt: new Date().toISOString(),
  });
  if (failure) throw failure.error;
  return info;
}

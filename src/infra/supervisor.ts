import { scrubSecrets } from "./env.ts";
import type { Subprocess } from "bun";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import type { ExitInfo, ExitReason } from "../domain/record.ts";
import { dispatchPaths, supervisorLockTarget } from "./dispatch-dir.ts";
import { tryLock } from "./filelock.ts";
import { lastLockOutput } from "./lock-activity.ts";
import { log } from "./log.ts";
import { killGroup, processStartTime } from "./proc.ts";
import { PRIVATE_FILE, writeJsonAtomic } from "./store.ts";

export const SuperviseSpecSchema = z.looseObject({
  schema: z.literal(1),
  backend: z.string(),
  dispatchDir: z.string(),
  cmd: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  /** plan 23: env vars set from another one at spawn (a gate env secret by reference): name → source name */
  envFrom: z.record(z.string(), z.string()).optional(),
  cwd: z.string(),
  stdinPath: z.string().nullable(),
  idleMs: z.number().positive(),
  wallMs: z.number().positive(),
  killGraceMs: z.number().nonnegative(),
  graceAfterFinalMs: z.number().nonnegative().nullable(),
  pollMs: z.number().positive(),
  /** plan 23: when provider retries end an attempt; PROVIDER_RETRY when absent (tests shorten it) */
  providerRetry: z
    .object({ attempts: z.number().positive(), ms: z.number().positive(), pollMs: z.number().positive() })
    .partial()
    .optional(),
});
export type SuperviseSpec = z.infer<typeof SuperviseSpecSchema>;

/**
 * Plan 23: an attempt that has only retried its provider (3 retries, or 3 min of nothing else) ends as
 * provider-unavailable; a quiet session's own retry field is read every pollMs.
 */
export const PROVIDER_RETRY = { attempts: 3, ms: 180_000, pollMs: 30_000 };

/** What one stream line tells the supervisor: the terminal event, the thread, a tool call opening or closing. */
interface LineInfo {
  final?: boolean;
  thread?: string;
  /** a tool call the CLI started (`open`) or finished: while one is open the run is busy, however quiet */
  item?: { id: string; open: boolean };
  /** plan 23: a model step started; one right after another, with nothing between, is a provider retry */
  step?: boolean;
}

export interface SuperviseHooks {
  onLine?(line: string): LineInfo;
  /** `sinceMs`: when this run started, so a backend can ignore what an earlier run on the thread left */
  isBusy?(thread: string | null, sinceMs: number): Promise<boolean>;
  interrupt?(thread: string | null): Promise<void>;
  /** plan 23: the provider retry attempt the session waits out (its own retry field), or null */
  providerRetry?(thread: string | null, sinceMs: number): Promise<number | null>;
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

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM the group, give it `graceMs` to leave, then SIGKILL whatever is left of it. */
export async function stopGroup(pgid: number, graceMs: number, pollMs: number): Promise<void> {
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

/**
 * Supervises one dispatch's worker, as the dispatch's only supervisor: it first takes the dispatch's
 * supervisor lock (a dead holder's is reclaimed) and holds it for its whole life. A supervisor that finds
 * a live one holding it returns null at once, before opening events or stderr (opened with "w") and
 * without exit.json, so a relaunch (recovery after a collector died between spawn and launch.json) never
 * starts a second worker.
 */
export async function supervise(spec: SuperviseSpec, hooks: SuperviseHooks = {}): Promise<ExitInfo | null> {
  const release = tryLock(supervisorLockTarget(spec.dispatchDir));
  if (!release) {
    log("info", "supervise", { dispatch: spec.dispatchDir, skipped: "another supervisor holds it" });
    return null;
  }
  try {
    return await superviseHeld(spec, hooks);
  } finally {
    release();
  }
}

async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promise<ExitInfo> {
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
    const stdout = openSync(p.events, "w", PRIVATE_FILE);
    fds.push(stdout);
    const stderr = openSync(p.stderr, "w", PRIVATE_FILE);
    fds.push(stderr);
    child = Bun.spawn([spec.cmd, ...spec.args], {
      cwd: spec.cwd,
      env: scrubSecrets(spec.env),
      stdin,
      stdout,
      stderr,
      detached: true,
    });
    log("info", "spawn", {
      backend: spec.backend,
      dispatch: spec.dispatchDir,
      argv: [spec.cmd, ...spec.args],
      env: scrubSecrets(spec.env),
      cwd: spec.cwd,
      pid: child.pid,
    });
  } catch (e) {
    try {
      appendFileSync(p.stderr, `catherd: could not start ${spec.cmd}: ${errorMessage(e)}\n`, {
        mode: PRIVATE_FILE,
      });
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
    const dispatchId = basename(spec.dispatchDir);
    let lastActivity = started;
    let finalAt: number | null = null;
    // spec §3.6: a quiet stretch of half the idle timeout, not busy, is a stall, reported once per dispatch
    let stalled = false;
    let stallChecked = false;
    const open = new Set<string>();
    const stream = { offset: 0, rest: "", decoder: new TextDecoder("utf-8") };

    // plan 23: a step that starts right after another with nothing between is a provider retry; retries are
    // not progress, and enough of them (or a long enough stretch) end the attempt as provider-unavailable
    let lastWasStep = false;
    let retries = 0;
    let retrySince: number | null = null;
    let lastRetryPoll = started;
    const retry = { ...PROVIDER_RETRY, ...spec.providerRetry };

    while (!done && reason === null) {
      await Bun.sleep(spec.pollMs);
      const lines = readNew(p.events, stream);
      let progress = false;
      for (const line of lines) {
        let d: LineInfo | undefined;
        try {
          d = hooks.onLine?.(line);
        } catch {
          // one line the hook cannot read must not end supervision; it is output all the same
          progress = true;
          lastWasStep = false;
          continue;
        }
        if (d?.step && lastWasStep) {
          retries++;
          retrySince ??= Date.now();
        } else {
          progress = true;
          if (!d?.step) {
            retries = 0;
            retrySince = null;
          }
        }
        lastWasStep = d?.step === true;
        if (d?.thread && d.thread !== thread) {
          thread = d.thread;
          // spec 1.5 plan 21: a live role's thread is on disk, so no delivery ever targets it
          try {
            writeJsonAtomic(p.thread, { schema: 1, thread, at: new Date().toISOString() });
          } catch (e) {
            log("warn", "supervise", { dispatch: spec.dispatchDir, error: errorMessage(e) });
          }
        }
        if (d?.final) finalAt ??= Date.now();
        if (d?.item) {
          if (d.item.open) open.add(d.item.id);
          else open.delete(d.item.id);
        }
      }
      if (progress) {
        lastActivity = Date.now();
        stallChecked = false;
      }
      // plan 23: a session quiet for a while may be waiting out a provider retry the stream does not show
      if (
        hooks.providerRetry &&
        Date.now() - lastActivity >= retry.pollMs &&
        Date.now() - lastRetryPoll >= retry.pollMs
      ) {
        lastRetryPoll = Date.now();
        const attempt = await bounded(() => hooks.providerRetry?.(thread, started), hookMs, null);
        if (attempt !== null) {
          retrySince ??= Date.now();
          retries = Math.max(retries, attempt);
        }
      }
      // a worker that ended on its own is recorded as it ended, even if a cancel or a limit arrived meanwhile
      if (done) break;
      const now = Date.now();
      if (existsSync(p.cancel)) reason = "cancelled";
      else if (now - started >= spec.wallMs && now - (lastLockOutput(dispatchId) ?? started) >= spec.wallMs)
        // plan 23: while a `catherd lock` of the role is alive and writing, the wall counts from its last output
        reason = "wall-timeout";
      else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
        reason = "after-final";
      else if (retries >= retry.attempts || (retrySince !== null && now - retrySince >= retry.ms))
        reason = "provider-unavailable";
      else if (now - lastActivity >= spec.idleMs) {
        const busy = open.size > 0 || (await bounded(() => hooks.isBusy?.(thread, started), hookMs, false));
        // the busy check can take up to hookMs: a worker that ended meanwhile is recorded as it ended, read
        // from the child itself too, since `done` is set by a callback that may not have run yet
        if (done || child.exitCode !== null || child.signalCode !== null) break;
        if (busy) {
          // a new quiet stretch starts: it gets its own stall check
          lastActivity = Date.now();
          stallChecked = false;
        } else reason = "idle-timeout";
      } else if (!stalled && !stallChecked && now - lastActivity >= spec.idleMs / 2) {
        // asked once per quiet stretch: a busy answer starts a new quiet stretch, with its own half-way check,
        // so a worker busy here and idle later is reported stalled before the idle check ends it
        stallChecked = true;
        const busy = open.size > 0 || (await bounded(() => hooks.isBusy?.(thread, started), hookMs, false));
        if (busy) {
          lastActivity = Date.now();
          stallChecked = false;
        } else if (!done) {
          stalled = true;
          // advisory: a write that fails is logged and never ends a healthy worker
          try {
            writeJsonAtomic(p.stall, {
              schema: 1,
              at: new Date().toISOString(),
              quietMs: Date.now() - lastActivity,
            });
          } catch (e) {
            log("warn", "stall", { dispatch: spec.dispatchDir, error: errorMessage(e) });
          }
        }
      }
    }
  } catch (e) {
    failure = { error: e };
    reason = "lost";
  }

  let stopped = false;
  if (reason !== null && !done) {
    if (reason !== "after-final" && failure === null && hooks.interrupt) {
      await bounded(() => hooks.interrupt?.(thread), hookMs, undefined);
      // a server-side stop lets the CLI end on its own: it gets the kill grace before any signal
      await Promise.race([child.exited, Bun.sleep(spec.killGraceMs)]);
    }
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

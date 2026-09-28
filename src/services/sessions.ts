import { z } from "zod";
import { sessionFileFor } from "../infra/claude-session.ts";
import { withFileLock } from "../infra/filelock.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl, writeJsonAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readNotes } from "./state.ts";

/** Spec §4: a Claude Code session as catherd records it. */
export interface SessionRef {
  sessionId: string;
  hostSessionId: string | null;
  name: string | null;
}

/**
 * The session this process serves (spec §3.3), read live: its registry file's id and name when it has one (the
 * id in the environment goes stale after /clear), else the environment's. Null outside Claude Code.
 */
export function currentSession(deps: Deps): SessionRef | null {
  const env = deps.session;
  if (!env) return null;
  const file = sessionFileFor(env);
  const sessionId = file?.sessionId ?? env.sessionId;
  if (!sessionId) return null;
  return { sessionId, hostSessionId: file?.hostSessionId ?? env.hostSessionId, name: file?.name ?? null };
}

const OwnerSchema = z.object({ sessionId: z.string(), since: z.string() });
export type Owner = z.infer<typeof OwnerSchema>;

/** The run's owner session (state.json `owner`), or null for a run no session has owned (1.0, a terminal). */
export function runOwner(run: Run): Owner | null {
  const r = OwnerSchema.safeParse((readNotes(run) as Record<string, unknown>).owner);
  return r.success ? r.data : null;
}

/** Whether this process serves a session and that session owns the run now. */
export function ownsRun(deps: Deps, run: Run): boolean {
  const me = currentSession(deps);
  return me !== null && runOwner(run)?.sessionId === me.sessionId;
}

const SessionRowSchema = z.looseObject({
  sessionId: z.string(),
  hostSessionId: z.string().nullable(),
  name: z.string().nullable(),
  at: z.string(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

/** `R/sessions.jsonl`: every session that has owned the run, in the order they took it. */
export function readSessionRows(run: Run): SessionRow[] {
  return readJsonl<unknown>(runPaths(run.dir).sessions).rows.flatMap((row) => {
    const r = SessionRowSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });
}

/**
 * Spec §3.3: `run_start`, `dispatch` and `peek` make the calling session the run's owner when it is not, and
 * append it to `R/sessions.jsonl`: that is how a run moves when it is continued from another session. Outside
 * Claude Code it changes nothing. Returns whether the owner changed.
 */
export async function claimRun(deps: Deps, run: Run): Promise<boolean> {
  const me = currentSession(deps);
  if (!me) return false;
  const p = runPaths(run.dir);
  const at = new Date(deps.now()).toISOString();
  // the trail row goes in under the same lock: the trail's last row is the owner (session-view reads it so)
  return withFileLock(p.stateJson, () => {
    const notes = readNotes(run);
    if (runOwner(run)?.sessionId === me.sessionId) return false;
    writeJsonAtomic(p.stateJson, { ...notes, owner: { sessionId: me.sessionId, since: at } });
    ensureJsonlHeader(p.sessions, "sessions");
    appendJsonl(p.sessions, { sessionId: me.sessionId, hostSessionId: me.hostSessionId, name: me.name, at });
    return true;
  });
}

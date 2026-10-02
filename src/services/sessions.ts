import { sessionKey, type HostSessionRef } from "../domain/host.ts";
import { z } from "zod";
import { sessionFileFor } from "../infra/claude-session.ts";
import { withFileLock } from "../infra/filelock.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl, writeJsonAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readNotes } from "./state.ts";

/** Spec §4: a host session as catherd records it. */
export type SessionRef = HostSessionRef;

/**
 * The session this process serves (spec §3.3), read live: its registry file's id and name when it has one (the
 * id in the environment goes stale after /clear), else the environment's. Null without known, consistent host identity.
 */
export function currentSession(deps: Deps): SessionRef | null {
  if (deps.host.host === "unknown" || deps.host.conflict) return null;
  if (deps.host.host === "codex") return deps.host.session;
  const env = deps.session;
  if (!env) return deps.host.session;
  const file = sessionFileFor(env);
  const sessionId = file?.sessionId ?? env.sessionId;
  if (!sessionId) return null;
  return {
    host: "claude-code",
    sessionId,
    hostSessionId: file?.hostSessionId ?? env.hostSessionId,
    name: file?.name ?? null,
  };
}

const OwnerSchema = z.looseObject({
  host: z.enum(["claude-code", "codex"]).default("claude-code"),
  sessionId: z.string(),
  since: z.string(),
});
export type Owner = z.infer<typeof OwnerSchema>;

/** The run's owner session (state.json `owner`), or null for a run no session has owned (1.0, a terminal). */
export function runOwner(run: Run): Owner | null {
  const r = OwnerSchema.safeParse((readNotes(run) as Record<string, unknown>).owner);
  return r.success ? r.data : null;
}

/** Whether this process serves a session and that session owns the run now. */
export function ownsRun(deps: Deps, run: Run): boolean {
  const me = currentSession(deps);
  const owner = runOwner(run);
  return me !== null && owner !== null && sessionKey(owner) === sessionKey(me);
}

const SessionRowSchema = z.looseObject({
  host: z.enum(["claude-code", "codex"]).default("claude-code"),
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
 * append it to `R/sessions.jsonl`: that is how a run moves when it is continued from another session. Without host session identity it changes nothing, and neither does a role's process (`deps.role`, spec 1.5 plan 21). Returns whether the owner changed.
 */
export async function claimRun(deps: Deps, run: Run): Promise<boolean> {
  // spec 1.5 plan 21: a role's process never becomes the run's owner, whatever host identity it has
  if (deps.role) return false;
  const me = currentSession(deps);
  if (!me) return false;
  const p = runPaths(run.dir);
  const at = new Date(deps.now()).toISOString();
  const row = (since: string): void => {
    ensureJsonlHeader(p.sessions, "sessions");
    appendJsonl(p.sessions, {
      host: me.host,
      sessionId: me.sessionId,
      hostSessionId: me.hostSessionId,
      name: me.name,
      at: since,
    });
  };
  // the trail row goes in under the same lock: the trail's last row is the owner (session-view reads it so)
  return withFileLock(p.stateJson, () => {
    const live = currentSession(deps);
    if (!live || sessionKey(live) !== sessionKey(me)) return false;
    const notes = readNotes(run);
    const owner = runOwner(run);
    if (owner && sessionKey(owner) === sessionKey(me)) {
      // a crash between the state.json write and the append left the trail without its owner: repaired here
      const last = readSessionRows(run).at(-1);
      if (!last || sessionKey(last) !== sessionKey(me)) row(owner.since);
      return false;
    }
    writeJsonAtomic(p.stateJson, {
      ...notes,
      owner: { ...owner, host: me.host, sessionId: me.sessionId, since: at },
    });
    row(at);
    return true;
  });
}

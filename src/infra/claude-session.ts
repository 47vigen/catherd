import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "./paths.ts";
import { isAlive } from "./proc.ts";

/**
 * The Claude Code session catherd's MCP server runs in (spec §3.3; docs/research/2026-09-28-cross-session-messaging.md):
 * what its environment says, and what the session's registry file (`<config>/sessions/<pid>.json`) says now.
 */

/** The four variables a Claude Code session hands its MCP servers; each may be absent. */
export const SESSION_ENV_KEYS = {
  sessionId: "CLAUDE_CODE_SESSION_ID",
  hostSessionId: "CLAUDE_CODE_HOST_SESSION_ID",
  socketPath: "CLAUDE_CODE_MESSAGING_SOCKET",
  token: "CLAUDE_CODE_MESSAGING_TOKEN",
} as const;

export interface SessionEnv {
  /** the id at spawn: it goes stale after /clear, so the registry's is preferred */
  sessionId: string | null;
  /** set only when a host (Desktop) launched the session */
  hostSessionId: string | null;
  socketPath: string | null;
  token: string | null;
}

/** The session's environment, or null outside Claude Code (neither a session id nor a socket). */
export function readSessionEnv(env: Record<string, string | undefined> = process.env): SessionEnv | null {
  const get = (k: string) => env[k] || null;
  const s: SessionEnv = {
    sessionId: get(SESSION_ENV_KEYS.sessionId),
    hostSessionId: get(SESSION_ENV_KEYS.hostSessionId),
    socketPath: get(SESSION_ENV_KEYS.socketPath),
    token: get(SESSION_ENV_KEYS.token),
  };
  return s.sessionId || s.socketPath ? s : null;
}

/** One live session's registry entry, as far as catherd reads it. */
export interface SessionFile {
  pid: number;
  sessionId: string;
  name: string | null;
  hostSessionId: string | null;
  messagingSocketPath: string | null;
  /** busy | idle | waiting, when the session says */
  status: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Every readable registry file (`<config>/sessions/<pid>.json`); a torn or foreign one is skipped. */
export function readSessionFiles(dir: string = join(claudeHome(), "sessions")): SessionFile[] {
  if (!existsSync(dir)) return [];
  const out: SessionFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const v = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const sessionId = str(v.sessionId);
      if (typeof v.pid !== "number" || !sessionId) continue;
      out.push({
        pid: v.pid,
        sessionId,
        name: str(v.name),
        hostSessionId: str(v.hostSessionId),
        messagingSocketPath: str(v.messagingSocketPath),
        status: str(v.status),
      });
    } catch {
      // written as we read it, or not Claude Code's
    }
  }
  return out;
}

/**
 * This server's session file: the one naming its socket, else its parent's pid (the MCP server is the session's
 * child), else the one with its env's session id. Null when none is found.
 */
export function sessionFileFor(
  s: SessionEnv,
  files = readSessionFiles(),
  ppid = process.ppid,
): SessionFile | null {
  return (
    (s.socketPath ? files.find((f) => f.messagingSocketPath === s.socketPath) : undefined) ??
    files.find((f) => f.pid === ppid) ??
    (s.sessionId ? files.find((f) => f.sessionId === s.sessionId) : undefined) ??
    null
  );
}

/** The live session that has `sessionId` now, if one does: its file names it and its process is alive. */
export function liveSessionFile(sessionId: string, files = readSessionFiles()): SessionFile | null {
  return files.find((f) => f.sessionId === sessionId && isAlive(f.pid, null)) ?? null;
}

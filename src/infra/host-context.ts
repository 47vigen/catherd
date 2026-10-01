import type { HostContext, KnownHost, OrchestrationHost } from "../domain/host.ts";
import { readSessionEnv, sessionFileFor } from "./claude-session.ts";

export function resolveHost(e: {
  clientName?: string;
  env: Record<string, string | undefined>;
  terminalHost?: OrchestrationHost;
}): HostContext {
  const conflict = (message: string): HostContext => ({ host: "unknown", session: null, conflict: message });
  const hosts = new Set<KnownHost>();
  const client = e.clientName;
  if (client === "codex-mcp-client") hosts.add("codex");
  if (client === "claude-code") hosts.add("claude-code");
  const launcher = e.env.CATHERD_ORCHESTRATION_HOST;
  if (launcher === "codex" || launcher === "claude-code") hosts.add(launcher);
  const claude = readSessionEnv(e.env);
  if (claude) hosts.add("claude-code");
  // UUIDs are case-insensitive: one spelling, so the launcher's and a request's casing name the same thread
  const thread = e.env.CODEX_THREAD_ID?.toLowerCase();
  const session = e.env.CODEX_SESSION_ID?.toLowerCase();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (thread !== undefined || session !== undefined) {
    hosts.add("codex");
    if ((thread !== undefined && !uuid.test(thread)) || (session !== undefined && !uuid.test(session)))
      return conflict("Codex session IDs must be UUIDs; remove invalid CODEX_THREAD_ID / CODEX_SESSION_ID");
    if (thread && session && thread !== session)
      return conflict("CODEX_THREAD_ID and CODEX_SESSION_ID disagree; correct the launcher environment");
  }
  if (hosts.size > 1)
    return conflict(
      "Initialized client and launcher session evidence disagree; remove the other host's environment",
    );
  const host = [...hosts][0] ?? e.terminalHost ?? "unknown";
  if (host === "codex")
    return {
      host,
      session:
        thread || session ? { host, sessionId: thread || session!, hostSessionId: null, name: null } : null,
      conflict: null,
    };
  if (host === "claude-code" && claude) {
    const file = sessionFileFor(claude);
    const id = file?.sessionId ?? claude.sessionId;
    return {
      host,
      session: id
        ? {
            host,
            sessionId: id,
            hostSessionId: file?.hostSessionId ?? claude.hostSessionId,
            name: file?.name ?? null,
          }
        : null,
      conflict: null,
    };
  }
  return { host, session: null, conflict: null };
}

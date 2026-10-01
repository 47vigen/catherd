export type OrchestrationHost = "claude-code" | "codex" | "unknown";
export type KnownHost = Exclude<OrchestrationHost, "unknown">;
export interface HostSessionRef {
  host: KnownHost;
  sessionId: string;
  hostSessionId: string | null;
  name: string | null;
}
export interface HostContext {
  host: OrchestrationHost;
  session: HostSessionRef | null;
  conflict: string | null;
}
export function sessionKey(s: Pick<HostSessionRef, "host" | "sessionId">): string {
  return JSON.stringify([s.host, s.sessionId]);
}

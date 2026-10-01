import type { HostContext } from "../domain/host.ts";
import { readSessionEnv } from "../infra/claude-session.ts";
import { VERSION } from "../infra/version.ts";
import type { Deps } from "../services/ports.ts";
import { profileService } from "../services/profile-service.ts";
import { routingService } from "../services/routing-service.ts";

/** The services every entry point (MCP server, CLI commands) runs on. */
export function defaultDeps(host: HostContext = { host: "unknown", session: null, conflict: null }): Deps {
  return {
    host,
    profiles: profileService(),
    routing: routingService(),
    version: VERSION,
    pollMs: 250,
    session: readSessionEnv(process.env),
    now: Date.now,
  };
}

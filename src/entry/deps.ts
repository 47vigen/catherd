import { VERSION } from "../infra/version.ts";
import type { Deps } from "../services/ports.ts";
import { profileService } from "../services/profile-service.ts";
import { routingService } from "../services/routing-service.ts";

/** The services every entry point (MCP server, CLI commands) runs on. */
export function defaultDeps(): Deps {
  return {
    profiles: profileService(),
    routing: routingService(),
    version: VERSION,
    pollMs: 250,
    tickMs: Number(process.env.CATHERD_TICK_MS) || 30_000,
    now: Date.now,
  };
}

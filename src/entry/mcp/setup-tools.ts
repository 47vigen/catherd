import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

const RUNG = z.string().regex(/^[a-z-]+:.+#[^#]+$/, "a rung is backend:model#effort");
const PROFILE = z.string().regex(ID_PATTERN).optional();
const isolation = z.object({ isolated: z.boolean() });

const PATCH = z.object({
  objective: z.enum(["cost", "speed"]).optional(),
  roles: z
    .partialRecord(
      z.enum(ROLES),
      z.object({
        enabled: z.boolean().optional(),
        rungs: z.array(RUNG).optional(),
        defaultRung: RUNG.optional(),
      }),
    )
    .optional(),
  harness: z.object({ codex: isolation.optional(), opencode: isolation.optional() }).optional(),
  lock: z.object({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]) }).optional(),
  notify: z.array(z.enum(["milestone", "finish", "blocked"])).optional(),
  failover: z.record(RUNG, RUNG).optional(),
  budget: z
    .object({
      minutes: z.number().positive().optional(),
      tokens: z.number().positive().optional(),
      usd: z.number().positive().optional(),
    })
    .optional(),
});

export function registerSetupTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "catalog_query",
    {
      description:
        "Models catherd can place, with capabilities, the roles they can fill, their scored rungs (backend:model#effort), any 'treat like', and whether catherd can run their backend here. Scored models first.",
      inputSchema: {
        role: z.enum(ROLES).optional(),
        backend: z.string().optional(),
        text: z.string().optional(),
        scored_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    (a) =>
      handle(() =>
        deps.routing.catalog({
          role: a.role,
          backend: a.backend,
          text: a.text,
          scoredOnly: a.scored_only,
          limit: a.limit,
        }),
      ),
  );

  server.registerTool(
    "profile_get",
    {
      description:
        "A profile (the active one without a name) as the run engine reads it, the active name, and every name.",
      inputSchema: { name: PROFILE },
    },
    (a) => handle(() => deps.profiles.get(a.name)),
  );

  server.registerTool(
    "profile_validate",
    {
      description:
        "Check a profile (the active one without a name): every enabled role has a usable rung, the worker's ladder covers every kind, no unscored rung without a 'treat like', failover stand-ins on another backend.",
      inputSchema: { name: PROFILE },
    },
    (a) => handle(() => deps.profiles.validate(a.name)),
  );

  server.registerTool(
    "profile_set",
    {
      description:
        "Apply a patch to a profile (the active one without a name): objective, roles (enabled, rungs, defaultRung), harness isolation, lock, notify, failover and budget. It validates first and writes nothing when invalid; otherwise it saves and regenerates the Claude agent files. Returns the diff and the agents that need a new Claude Code session.",
      inputSchema: { name: PROFILE, patch: PATCH },
    },
    (a) => handle(() => deps.profiles.set(a.name, a.patch)),
  );
}

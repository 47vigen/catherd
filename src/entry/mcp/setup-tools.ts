import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PROFILE_NAME, ProfilePatchSchema } from "../../domain/profile.ts";
import { ROLES } from "../../domain/roles.ts";
import { gitToplevel } from "../../infra/git.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

const PROFILE = z.string().regex(PROFILE_NAME).optional();

export function registerSetupTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "catalog_query",
    {
      description:
        "Models catherd can place, with capabilities, the roles they can fill, their scored rungs (backend:model#effort), any 'treat like', their cost under the active profile's billing, and whether this account's last listing offers them (`listed: false`: it does not); `enabled: false` rungs are unscored. Scored models first. opencode's models are as listed in `repo` (default: this server's directory), as route sees them there.",
      inputSchema: {
        repo: z.string().min(1).optional(),
        role: z.enum(ROLES).optional(),
        backend: z.string().optional(),
        text: z.string().optional(),
        scored_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    (a) =>
      handle(async () =>
        deps.routing.catalog(
          {
            role: a.role,
            backend: a.backend,
            text: a.text,
            scoredOnly: a.scored_only,
            limit: a.limit,
            // outside a git repository: the global listings
            repo: (await gitToplevel(a.repo ?? process.cwd())) ?? undefined,
          },
          deps.profiles.forRepo(null).billing,
        ),
      ),
  );

  server.registerTool(
    "profile_get",
    {
      description:
        "A profile (the active one without a name) as the run engine reads it, with every default filled in: per role its access mode, rungs and default rung, and whether its backend enforces the access (enforcement); billing, jev, harness isolation, failover, budget, timeouts, preflight, lock and notify. Also the active name and every name.",
      inputSchema: { name: PROFILE },
    },
    (a) => handle(() => deps.profiles.get(a.name)),
  );

  server.registerTool(
    "profile_validate",
    {
      description:
        "Check a profile (the active one without a name). errors block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a 'treat like', a failover stand-in unscored or on the same quota, a backend catherd cannot run. warnings do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs. Each has a path, a message and often a fix.",
      inputSchema: { name: PROFILE },
    },
    (a) => handle(() => deps.profiles.validate(a.name)),
  );

  server.registerTool(
    "profile_set",
    {
      description:
        "Apply a patch to a profile (the active one without a name; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, rungs, defaultRung), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid; otherwise it saves, rewrites the agent files and relinks them. Returns the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
      inputSchema: { name: PROFILE, patch: ProfilePatchSchema },
    },
    (a) => handle(() => deps.profiles.set(a.name, a.patch)),
  );
}

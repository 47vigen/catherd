import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CatherdError } from "../../domain/errors.ts";
import { PROFILE_NAME, ProfilePatchSchema } from "../../domain/profile.ts";
import { ROLES } from "../../domain/roles.ts";
import { gitToplevel } from "../../infra/git.ts";
import type { Deps } from "../../services/ports.ts";
import { refreshIndex } from "../../services/catalog-service.ts";
import { handle } from "./result.ts";

const PROFILE = z.string().regex(PROFILE_NAME).optional();
const REPO = z.string().min(1).optional();

/**
 * The git toplevel of `repo` (default: this server's directory, null outside a repository). A `repo`
 * given outside a repository is refused, as run_start does: never the global profile in its stead.
 */
const toplevel = async (repo: string | undefined): Promise<string | null> => {
  const top = await gitToplevel(repo ?? process.cwd());
  if (top === null && repo !== undefined)
    throw new CatherdError("E_IO_PATH", `${repo} is not inside a git repository`, {
      fix: "pass the path of the repository, or leave repo out for the active profile",
    });
  return top;
};

export function registerSetupTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "catalog_query",
    {
      description:
        "The indexed Slopalytics pairs catherd can place, by model: capabilities, the roles they can fill, and per pair (backend:model#effort) its intelligence index, price, speed, context, cost under the billing of `repo`'s profile and catherd's own run evidence; `listed: false` means this account's last listing does not offer the model. A model or effort Slopalytics has no index for is not listed. opencode's models are as listed in `repo` (default: this server's directory), as route sees them there.",
      inputSchema: {
        repo: z.string().min(1).optional(),
        role: z.enum(ROLES).optional(),
        backend: z.string().optional(),
        text: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    (a) =>
      handle(async () => {
        // outside a git repository: the global listings and the active profile
        const repo = (await gitToplevel(a.repo ?? process.cwd())) ?? undefined;
        return deps.routing.catalog(
          { role: a.role, backend: a.backend, text: a.text, limit: a.limit, repo },
          deps.profiles.forRepo(repo ?? null).billing,
        );
      }),
  );

  server.registerTool(
    "catalog_sync",
    {
      description:
        "Fetch the Slopalytics index now (it is refreshed at most hourly unless `force`). Returns { fetchedAt, checkedAt, pairs, error }: a failed fetch keeps the last good index and names the error. route and catalog_query read the result at once.",
      inputSchema: { force: z.boolean().default(false) },
    },
    (a) =>
      handle(async () => {
        return (deps.sync ?? ((o) => refreshIndex({ force: o.force })))({ force: a.force });
      }),
  );

  server.registerTool(
    "profile_get",
    {
      description:
        "A profile (without a name: the profile this repo runs on, i.e. the one bound to `repo`, default this server's directory, else the active one) as the run engine reads it, with every default filled in: per role its access mode, rungs and default rung, and whether its backend enforces the access (enforcement); billing, jev, harness isolation, failover, budget, timeouts, preflight, lock and notify. Also `active` (the global active profile), `here` (the profile this repo runs on) and every name.",
      inputSchema: { name: PROFILE, repo: REPO, raw: z.boolean().optional() },
    },
    (a) =>
      handle(async () =>
        a.raw && deps.profiles.raw
          ? deps.profiles.raw(a.name, await toplevel(a.repo))
          : deps.profiles.get(a.name, await toplevel(a.repo)),
      ),
  );

  server.registerTool(
    "profile_validate",
    {
      description:
        "Check a profile (without a name: the profile this repo runs on, as in profile_get). errors block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a 'treat like', a failover stand-in unscored or on the same quota, a backend catherd cannot run. warnings do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs, a quota none of whose rungs ever starts a lane, and every kind and difficulty no worker rung clears. Each has a path, a message and often a fix.",
      inputSchema: { name: PROFILE, repo: REPO },
    },
    (a) => handle(async () => deps.profiles.validate(a.name, await toplevel(a.repo))),
  );

  server.registerTool(
    "profile_set",
    {
      description:
        "Apply a patch to a profile (without a name: the profile this repo runs on, as in profile_get; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, network, rungs, defaultRung, timeouts: a role's own idleMin and wallMin over the profile's), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid, unless the patch repairs an invalid profile: it fixes at least one of its errors and adds none, and then it saves with `errors` listing those still open. A save rewrites the agent files and relinks them. Returns saved, the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
      inputSchema: { name: PROFILE, repo: REPO, patch: ProfilePatchSchema },
    },
    (a) => handle(async () => deps.profiles.set(a.name, a.patch, await toplevel(a.repo))),
  );
}

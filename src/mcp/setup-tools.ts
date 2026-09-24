import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import diff from "microdiff";
import { z } from "zod";
import { formatHarness, harnessCosts } from "../core/harness.ts";
import { ID } from "../core/lanes.ts";
import { listRuns } from "../core/runstore.ts";
import { runsSummary } from "../core/status.ts";
import { claudeAgentsDir, saveProfileAndAgents } from "../profile/agents.ts";
import {
  activeProfileName,
  defaultProfile,
  listProfiles,
  loadProfile,
  patchProfile,
  type ProfilePatch,
  validateProfile,
} from "../profile/profile.ts";
import { capableFor, loadCatalog } from "../routing/catalog.ts";
import { type Backend, type Profile, ROLES, splitRung } from "../types.ts";
import { json } from "./out.ts";

const isolation = z.object({ isolated: z.boolean() });

const PATCH = z.object({
  objective: z.enum(["cost", "speed"]).optional(),
  roles: z
    .partialRecord(
      z.enum(ROLES),
      z.object({
        enabled: z.boolean().optional(),
        models: z.record(z.string(), z.array(z.string())).optional(),
        defaultRung: z.string().optional(),
      }),
    )
    .optional(),
  harness: z.object({ codex: isolation.optional(), opencode: isolation.optional() }).optional(),
  lock: z.object({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]) }).optional(),
  notify: z.array(z.enum(["milestone", "finish", "blocked"])).optional(),
});

/** Whether each backend's CLI is on PATH. Claude is always available: it needs no CLI, only agent files. */
function installedBackends(): Record<Backend, boolean> {
  const probe = (bin: string) =>
    Bun.spawnSync([bin, "--version"], { stdout: "ignore", stderr: "ignore" }).success;
  return { codex: probe("codex"), opencode: probe("opencode"), claude: true };
}

const profileOrNew = (name: string): Profile =>
  listProfiles().includes(name) ? loadProfile(name) : { ...defaultProfile(), name };

export function registerSetupTools(server: McpServer): void {
  server.registerTool(
    "catalog_query",
    {
      description:
        "Models catherd can place, with their capabilities, the roles they are capable for, their scored rungs, any 'treat like', and whether their backend is installed. Scored models first.",
      inputSchema: {
        role: z.enum(ROLES).optional(),
        backend: z.enum(["codex", "opencode", "claude"]).optional(),
        text: z.string().optional(),
        scored_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async (a) => {
      const c = loadCatalog();
      const installed = installedBackends();
      const needle = a.text?.toLowerCase();
      const models = c.models
        .filter(
          (m) =>
            (!a.role || capableFor(a.role, m)) &&
            (!a.backend || m.backend === a.backend) &&
            (!needle || m.id.toLowerCase().includes(needle)),
        )
        .map((m) => ({
          id: m.id,
          backend: m.backend,
          installed: installed[m.backend],
          efforts: m.efforts,
          capabilities: m.capabilities,
          roles: ROLES.filter((r) => capableFor(r, m)),
          scored: c.entries.filter((e) => splitRung(e.rung).model === m.id),
          treatLike: Object.fromEntries(
            Object.entries(c.treatLike).filter(([k]) => splitRung(k).model === m.id),
          ),
        }))
        .filter((m) => !a.scored_only || m.scored.length > 0 || Object.keys(m.treatLike).length > 0)
        .sort((x, y) => y.scored.length - x.scored.length || x.id.localeCompare(y.id));
      return json({ total: models.length, models: models.slice(0, a.limit) });
    },
  );

  server.registerTool(
    "profile_get",
    {
      description:
        "A profile (the active one without a name), the active profile's name, and every profile name.",
      inputSchema: { name: z.string().regex(ID).optional() },
    },
    async (a) => {
      const active = activeProfileName();
      return json({ active, profiles: listProfiles(), profile: loadProfile(a.name ?? active) });
    },
  );

  server.registerTool(
    "profile_validate",
    {
      description:
        "Check a profile (the active one without a name): every enabled role has a capable model, the worker's ladder is non-empty for every kind, and no unscored model is enabled without its 'treat like'.",
      inputSchema: { name: z.string().regex(ID).optional() },
    },
    async (a) => {
      const errors = validateProfile(loadProfile(a.name ?? activeProfileName()), loadCatalog());
      return json({ valid: errors.length === 0, errors });
    },
  );

  server.registerTool(
    "profile_set",
    {
      description:
        "Apply a patch to a profile (the active one without a name). It validates first and writes nothing when invalid; otherwise it saves the profile and regenerates the Claude agent files. Returns the diff and the agents that need a new Claude Code session.",
      inputSchema: { name: z.string().regex(ID).optional(), patch: PATCH },
    },
    async (a) => {
      const c = loadCatalog();
      const before = profileOrNew(a.name ?? activeProfileName());
      const { harness, ...rest } = a.patch;
      const patched = patchProfile(before, rest as ProfilePatch);
      const after: Profile = harness ? { ...patched, harness: { ...patched.harness, ...harness } } : patched;
      const errors = validateProfile(after, c);
      if (errors.length) return json({ saved: false, errors });
      const dir = claudeAgentsDir();
      const had = new Set(existsSync(dir) ? readdirSync(dir) : []);
      const agents = saveProfileAndAgents(after, c);
      return json({
        saved: true,
        diff: diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>),
        agents,
        new_session_needed_for: agents.linked
          .filter((l) => !had.has(basename(l)))
          .map((l) => basename(l, ".md")),
      });
    },
  );

  server.registerTool(
    "runs_summary",
    {
      description:
        "Per role and rung over past runs: runs, ok, refusals, climbs from that rung, seconds and tokens; plus what the user's harness customizations cost per run.",
      inputSchema: {
        run: z.string().optional(),
        repo: z.string().optional(),
        role: z.enum(ROLES).optional(),
        since_days: z.number().positive().optional(),
      },
    },
    async (a) => {
      const harness = harnessCosts(listRuns().map((r) => r.dir)).map((h) => ({
        ...h,
        line: formatHarness(h),
      }));
      return json({
        rungs: runsSummary({ run: a.run, repo: a.repo, role: a.role, sinceDays: a.since_days }),
        harness,
      });
    },
  );
}

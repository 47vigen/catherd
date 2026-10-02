import { tryParseRung } from "../domain/ids.ts";
import type { Profile } from "../domain/profile.ts";
import { roleMcpTools } from "../domain/role-tools.ts";
import { ROLES } from "../domain/roles.ts";
import { ROLE_MCP_STARTUP_SEC, type RoleServerStart } from "../infra/role-mcp.ts";
import { standInFor } from "./backends.ts";
import type { Check } from "./doctor-checks.ts";

/**
 * The active profile's role server, per backend that runs one (codex, claude-code), isolated or not (spec 1.5
 * plan 21, #42 finding 6): the roles that get it and their tools, and, when doctor probed it, how long a cold
 * start took against Codex's startup timeout. A start past half that timeout warns: on a loaded machine Codex,
 * which requires the server, would abort the role.
 */
export function roleMcpChecks(profile: Profile | null, start?: RoleServerStart): Check[] {
  if (!profile) return [];
  const checks: Check[] = [];
  for (const backend of ["codex", "claude-code"] as const) {
    const uses = (rung: string) => tryParseRung(rung)?.backend === backend;
    const roles = ROLES.filter((role) => {
      const configured = profile.roles[role];
      return (
        configured.enabled &&
        configured.rungs.some((rung) => {
          const failover = standInFor(profile.failover, rung);
          return uses(rung) || (failover !== null && uses(failover));
        })
      );
    });
    if (!roles.length) continue;
    const base = { id: `role-mcp:${profile.name}:${backend}`, label: `${profile.name} ${backend} role MCP` };
    const tools = [...new Set(roles.flatMap(roleMcpTools))];
    const configured = `${roles.join(", ")}: scoped catherd_role exposes ${tools.join(", ")}; ${backend === "codex" ? "per-tool approval_mode=approve" : "exact MCP tool allowlist"}. Model invocation not tested; managed policy may still deny tools.`;
    const limit = ROLE_MCP_STARTUP_SEC * 1000;
    if (start && !start.ok) {
      checks.push({
        ...base,
        state: "fail",
        word: "no start",
        detail: `the role server did not start: ${start.error}`,
        fix: "reinstall catherd at this version, then run catherd doctor again",
      });
      continue;
    }
    if (start?.ok && start.ms > limit / 2) {
      checks.push({
        ...base,
        state: "warn",
        word: "slow start",
        detail: `the role server took ${Math.round(start.ms)} ms to start; Codex gives it ${ROLE_MCP_STARTUP_SEC} s and stops the role when it misses`,
        fix: "install catherd globally (catherd init) so roles start it without resolving a package, and check the machine's load",
      });
      continue;
    }
    checks.push({
      ...base,
      state: "info",
      word: "configured",
      detail: start?.ok
        ? `${configured} Starts in ${Math.round(start.ms)} ms (limit ${ROLE_MCP_STARTUP_SEC} s).`
        : configured,
    });
  }
  return checks;
}

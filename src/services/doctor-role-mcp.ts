import { existsSync } from "node:fs";
import { tryParseRung } from "../domain/ids.ts";
import type { Profile } from "../domain/profile.ts";
import { roleMcpTools, roleRequiresMcp } from "../domain/role-tools.ts";
import { ROLES } from "../domain/roles.ts";
import { ROLE_MCP_ENTRY } from "../infra/role-mcp.ts";
import { standInFor } from "./backends.ts";
import type { Check } from "./doctor-checks.ts";

/** Static configuration only: no model turn, scratch run or tool invocation. */
export function roleMcpChecks(profiles: Profile[]): Check[] {
  const checks: Check[] = [];
  for (const profile of profiles) {
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
      const base = {
        id: `role-mcp:${profile.name}:${backend}`,
        label: `${profile.name} ${backend} role MCP`,
      };
      const isolated = profile.harness[backend]?.isolated ?? false;
      const blocked = isolated ? roles.filter(roleRequiresMcp) : [];
      if (blocked.length) {
        checks.push({
          ...base,
          state: "fail",
          word: "isolated",
          detail: `${blocked.join(", ")} require run artifact or gate tools, unavailable in isolated mode`,
          fix: `Set harness.${backend}.isolated to false for profile ${profile.name}, or select a supported native role backend.`,
        });
        continue;
      }
      if (isolated) {
        checks.push({
          ...base,
          state: "skip",
          word: "isolated",
          detail: "role MCP is not injected in isolated mode",
        });
        continue;
      }
      if (!existsSync(ROLE_MCP_ENTRY)) {
        checks.push({
          ...base,
          state: "fail",
          word: "missing",
          detail: "role MCP entry point is missing from this installation",
          fix: "Reinstall catherd at this version.",
        });
        continue;
      }
      const tools = [...new Set(roles.flatMap(roleMcpTools))];
      checks.push({
        ...base,
        state: "info",
        word: "configured",
        detail: `${roles.join(", ")}: scoped catherd_role exposes ${tools.join(", ")}; ${backend === "codex" ? "per-tool approval_mode=approve" : "exact MCP tool allowlist"}. Model invocation not tested; managed policy may still deny tools.`,
      });
    }
  }
  return checks;
}

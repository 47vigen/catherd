import { parseRung } from "./ids.ts";
import { agentName, type Profile } from "./profile.ts";
import type { Access } from "./record.ts";
import { nativeDisallowedTools, rolePrompt } from "./role-prompts.ts";
import { ROLES, type Role } from "./roles.ts";

export interface AgentFile {
  /** the agent's name, also its file name without `.md` */
  name: string;
  role: Role;
  rung: string;
  text: string;
}

/** One native subagent's file: Claude Code reads `name`, `model`, `effort` and the tool list. */
export function renderAgent(o: {
  profile: string;
  role: Role;
  rung: string;
  access: Access;
  version: string;
}): string {
  const { model, effort } = parseRung(o.rung);
  return [
    "---",
    `name: ${agentName(o.profile, o.role, o.rung)}`,
    `description: Internal ${o.role} role of the catherd orchestrator (profile ${o.profile}), on ${model}${effort === "default" ? "" : ` at ${effort} effort`}. Dispatched only by the catherd skill while a run is in flight. Never for a plain request, even one that names this role.`,
    `model: ${model}`,
    ...(effort === "default" ? [] : [`effort: ${effort}`]),
    `disallowedTools: ${nativeDisallowedTools(o.access).join(", ")}`,
    "---",
    "",
    rolePrompt(o.role, o.version),
    "",
  ].join("\n");
}

/**
 * Spec §7.3: an agent file per enabled role and native `claude:` rung, counting a native stand-in for one
 * of the role's rungs, since dispatch hands those to the orchestrator as an Agent to start.
 */
export function agentFiles(p: Profile, version: string): AgentFile[] {
  const out = new Map<string, AgentFile>();
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled) continue;
    const rungs = [...rc.rungs, ...rc.rungs.flatMap((r) => p.failover[r] ?? [])];
    for (const rung of rungs) {
      let native: boolean;
      try {
        native = parseRung(rung).backend === "claude";
      } catch {
        continue;
      }
      if (!native) continue;
      const name = agentName(p.name, role, rung);
      out.set(name, {
        name,
        role,
        rung,
        text: renderAgent({ profile: p.name, role, rung, access: rc.access, version }),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

import type { Role } from "./roles.ts";

export interface RoleMcpContext {
  run: string;
  role: Role;
}

export const ROLE_MCP_SERVER = "catherd_role";

/** Spec 1.5 plan 21: the backends whose harness gets the role server, isolated or not. */
export const ROLE_SERVER_BACKENDS: readonly string[] = ["codex", "claude-code"];

/**
 * Spec 1.5 plan 21: the backends whose sandbox catherd grants the role's scratch, so they get it as TMPDIR.
 * Cursor writes their grants once per isolated home, not per dispatch: it keeps the inherited one.
 */
export const SCRATCH_BACKENDS: readonly string[] = ["codex", "claude-code", "opencode"];

/**
 * Whether a role on `backend` gets its scratch as TMPDIR. Plan 44 D12: opencode always does, isolated or not, so its
 * temp files never land in the shared /tmp.
 */
export function grantsScratch(backend: string, _isolated: boolean): boolean {
  return SCRATCH_BACKENDS.includes(backend);
}

/** Run artifacts and gate evidence have their own authority, independent of repository writes. */
export function roleMcpTools(role: Role): string[] {
  const tools = ["read_run_file", "read_knowledge"];
  if (role === "architect" || role === "researcher") tools.push("write_run_file");
  if (role === "verifier") tools.push("gate_check", "gate_pass", "gate_run");
  if (role === "worker" || role === "writer") tools.push("team_send", "team_read", "team_wait");
  if (role === "architect") tools.push("team_send", "team_read");
  return tools;
}

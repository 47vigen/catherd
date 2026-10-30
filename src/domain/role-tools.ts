import type { Role } from "./roles.ts";

export interface RoleMcpContext {
  run: string;
  role: Role;
}

/** Plan 47, spec D3: the architect's orchestration tools (T3 Code's contract, ported). */
export const ARCHITECT_TOOLS = [
  "capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "thread_send",
  "thread_read",
  "thread_wait",
  "check",
  "merge",
  "ledger",
  "findings",
  "oracle_accept",
  "land",
  "ask_owner",
  "finish",
] as const;
export type ArchitectTool = (typeof ARCHITECT_TOOLS)[number];

/** Spec D12: a worker or a writer calls the standing roles through the same tools, on its own tasks only. */
export const DELEGATOR_TOOLS: readonly ArchitectTool[] = ["delegate_task", "task_status", "thread_wait"];

export const ROLE_MCP_SERVER = "catherd_role";

/** Spec 1.5 plan 21: the backends whose harness gets the role server, isolated or not. */
export const ROLE_SERVER_BACKENDS: readonly string[] = ["codex", "claude-code"];

/**
 * Spec 1.5 plan 21: the backends whose sandbox catherd grants the role's scratch, so they get it as TMPDIR.
 */
export const SCRATCH_BACKENDS: readonly string[] = ["codex", "claude-code", "opencode"];

/**
 * Whether a role on `backend` gets its scratch as TMPDIR. Plan 44 D12: opencode always does, isolated or not, so its
 * temp files never land in the shared /tmp.
 */
export function grantsScratch(backend: string, _isolated: boolean): boolean {
  return SCRATCH_BACKENDS.includes(backend);
}

/** Run artifacts have their own authority, independent of repository writes. */
export function roleMcpTools(role: Role): string[] {
  const tools = ["read_run_file", "read_knowledge"];
  if (role === "architect" || role === "researcher" || role === "writer") tools.push("write_run_file");
  if (role === "worker" || role === "writer") tools.push("team_send", "team_read");
  if (role === "architect") tools.push("team_send", "team_read", ...ARCHITECT_TOOLS);
  if (role === "worker" || role === "writer") tools.push(...DELEGATOR_TOOLS);
  return tools;
}

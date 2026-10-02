import type { Role } from "./roles.ts";

export interface RoleMcpContext {
  run: string;
  role: Role;
}

export const ROLE_MCP_SERVER = "catherd_role";

/** Run artifacts and gate evidence have their own authority, independent of repository writes. */
export function roleMcpTools(role: Role): string[] {
  const tools = ["read_run_file", "read_knowledge"];
  if (role === "architect" || role === "researcher") tools.push("write_run_file");
  if (role === "verifier") tools.push("gate_check", "gate_pass");
  return tools;
}

/** These role prompts require artifacts or gate records to complete their work. */
export const roleRequiresMcp = (role: Role): boolean =>
  role === "architect" || role === "researcher" || role === "worker" || role === "verifier";

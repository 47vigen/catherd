import { fileURLToPath } from "node:url";
import { type RoleMcpContext, ROLE_MCP_SERVER, roleMcpTools } from "../domain/role-tools.ts";
import { configDir, dataDir } from "./paths.ts";

export const ROLE_MCP_ENTRY = fileURLToPath(new URL("../entry/mcp/role-bin.ts", import.meta.url));

/** Launch the same installed package as the dispatching process, without resolving another release. */
export function roleMcpConfig(context: RoleMcpContext): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: process.execPath,
    args: [ROLE_MCP_ENTRY, context.role, context.run],
    env: { CATHERD_CONFIG_DIR: configDir(), CATHERD_DATA_DIR: dataDir() },
  };
}

export function codexRoleMcpArgs(context: RoleMcpContext): string[] {
  const config = roleMcpConfig(context);
  const prefix = `mcp_servers.${ROLE_MCP_SERVER}`;
  const settings = [
    `${prefix}.command=${JSON.stringify(config.command)}`,
    `${prefix}.args=${JSON.stringify(config.args)}`,
    ...Object.entries(config.env).map(([key, value]) => `${prefix}.env.${key}=${JSON.stringify(value)}`),
    `${prefix}.enabled=true`,
    `${prefix}.required=true`,
    `${prefix}.enabled_tools=${JSON.stringify(roleMcpTools(context.role))}`,
    ...roleMcpTools(context.role).map((tool) => `${prefix}.tools.${tool}.approval_mode="approve"`),
  ];
  return settings.flatMap((setting) => ["-c", setting]);
}

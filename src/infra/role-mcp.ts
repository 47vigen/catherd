import { fileURLToPath } from "node:url";
import { type RoleMcpContext, ROLE_MCP_SERVER, roleMcpTools } from "../domain/role-tools.ts";
import { scrubSecrets } from "./env.ts";
import { configDir, dataDir } from "./paths.ts";

export const ROLE_MCP_ENTRY = fileURLToPath(new URL("../entry/mcp/role-bin.ts", import.meta.url));

/** How long Codex waits for the role server to start (spec 1.5 plan 21, #42 finding 8). */
export const ROLE_MCP_STARTUP_SEC = 30;

export type RoleServerStart = { ok: true; ms: number } | { ok: false; error: string };

/**
 * Doctor's probe: a cold start of the role server's entry, which loads the server's whole module graph and
 * exits (`--probe`), timed against the startup timeout. Never a model turn.
 */
export async function probeRoleServer(timeoutMs = ROLE_MCP_STARTUP_SEC * 1000): Promise<RoleServerStart> {
  const started = performance.now();
  const p = Bun.spawn([process.execPath, ROLE_MCP_ENTRY, "--probe"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...scrubSecrets(process.env), CATHERD_NO_SYNC: "1" },
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  try {
    const code = await p.exited;
    const ms = performance.now() - started;
    const out = await new Response(p.stdout).text();
    if (code === 0 && out.trim() === "ready") return { ok: true, ms };
    const err = (await new Response(p.stderr).text()).trim().split("\n").at(-1);
    return {
      ok: false,
      error: p.signalCode === "SIGKILL" ? `no answer in ${timeoutMs} ms` : err || `exit ${code}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

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
    // required: a role without its run tools cannot work; doctor's probe shows it starts well inside the timeout
    `${prefix}.required=true`,
    `${prefix}.startup_timeout_sec=${ROLE_MCP_STARTUP_SEC}`,
    `${prefix}.enabled_tools=${JSON.stringify(roleMcpTools(context.role))}`,
    ...roleMcpTools(context.role).map((tool) => `${prefix}.tools.${tool}.approval_mode="approve"`),
  ];
  return settings.flatMap((setting) => ["-c", setting]);
}

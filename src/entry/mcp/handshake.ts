import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { errorMessage } from "../../domain/errors.ts";
import { scrubSecrets } from "../../infra/env.ts";
import { VERSION } from "../../infra/version.ts";
import type { Handshake } from "../../services/doctor.ts";

/** The plugin's MCP launcher, shipped in the package beside src/ (spec 1.1 §12). */
export const LAUNCHER = fileURLToPath(new URL("../../../plugin/bin/catherd-mcp", import.meta.url));
/** A cold `bunx catherd-cli@<version>` resolve took about 30 s in the 1.0.0 fresh install. */
const TIMEOUT_MS = 60_000;
const STDERR_TAIL = 4_000;

/** The env the doctor's MCP server starts with: catherd's own secrets scrubbed, as for every process it starts. */
export const handshakeEnv = (
  base: Record<string, string | undefined> = process.env,
): Record<string, string> => {
  const env = scrubSecrets(base);
  for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CATHERD_ORCHESTRATION_HOST"]) delete env[key];
  return env;
};

/**
 * Spec §10.3 and 1.1 §12: starts the MCP server the way the plugin does, `sh <launcher>` over stdio, and
 * asks it for tools/list. What it writes to stderr comes back too, so doctor can say what broke.
 */
export async function mcpHandshake(o: { launcher?: string } = {}): Promise<Handshake> {
  const client = new Client({ name: "catherd-doctor", version: VERSION });
  const transport = new StdioClientTransport({
    command: "sh",
    args: [o.launcher ?? LAUNCHER],
    env: handshakeEnv(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-STDERR_TAIL);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Handshake>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, tools: [], error: `no answer within ${TIMEOUT_MS / 1000} s`, stderr }),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      (async (): Promise<Handshake> => {
        await client.connect(transport);
        const r = await client.listTools();
        return { ok: true, tools: r.tools.map((t) => t.name) };
      })(),
      late,
    ]);
  } catch (e) {
    return { ok: false, tools: [], error: errorMessage(e), stderr };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {}); // the answer (or the failure) is already in hand
  }
}

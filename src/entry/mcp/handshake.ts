import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { errorMessage } from "../../domain/errors.ts";
import { VERSION } from "../../infra/version.ts";
import type { Handshake } from "../../services/doctor.ts";

const CLI = fileURLToPath(new URL("../../cli.ts", import.meta.url));
const TIMEOUT_MS = 20_000;

/** Spec §10.3: starts `catherd mcp` over stdio, as Claude Code would, and asks it for tools/list. */
export async function mcpHandshake(): Promise<Handshake> {
  const client = new Client({ name: "catherd-doctor", version: VERSION });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Handshake>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, tools: [], error: `no answer within ${TIMEOUT_MS / 1000} s` }),
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
    return { ok: false, tools: [], error: errorMessage(e) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

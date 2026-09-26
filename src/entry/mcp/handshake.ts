import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../../infra/version.ts";
import type { Handshake } from "../../services/doctor.ts";

const CLI = fileURLToPath(new URL("../../cli.ts", import.meta.url));

/** Spec §10.3: starts `catherd mcp` over stdio, as Claude Code would, and asks it for tools/list. */
export async function mcpHandshake(timeoutMs = 20_000): Promise<Handshake> {
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
      () => resolve({ ok: false, tools: [], error: `no answer within ${timeoutMs / 1000} s` }),
      timeoutMs,
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
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

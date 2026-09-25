import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/entry/mcp/server.ts";
import type { Deps } from "../src/services/ports.ts";

/** An SDK client on an in-memory server; the default deps are the real 0.x bridge. */
export async function mcpClient(deps?: Deps): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await buildServer(deps).connect(serverSide);
  const client = new Client({ name: "catherd-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

export interface CallResult {
  isError: boolean;
  // oxlint-disable-next-line typescript/no-explicit-any
  data: any;
  error: { code: string; message: string; fix: string } | null;
  raw: string;
}

export async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const r = await c.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
    resetTimeoutOnProgress: true,
  });
  const raw = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // a text result
  }
  const isError = r.isError === true;
  return {
    isError,
    data: isError ? null : data,
    error: isError ? (r.structuredContent as CallResult["error"]) : null,
    raw,
  };
}

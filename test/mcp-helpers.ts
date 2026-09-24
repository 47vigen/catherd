import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.ts";

export async function mcpClient(): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: "catherd-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

export async function call(
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
  onprogress?: (p: { progress: number; message?: string }) => void,
  // oxlint-disable-next-line typescript/no-explicit-any
): Promise<{ isError: boolean; data: any; raw: string }> {
  const r = await c.callTool(
    { name, arguments: args },
    undefined,
    onprogress ? { onprogress, timeout: 60_000 } : undefined,
  );
  const raw = (r.content as { type: string; text?: string }[])[0]?.text ?? "";
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    /* a text result */
  }
  return { isError: r.isError === true, data, raw };
}

/** run_start needs a Jev key; the key is removed again at once, so later Jev calls fall back to defaults offline. */
export async function startRun(c: Client, repo: string, title = "t"): Promise<{ run: string; dir: string }> {
  process.env.TYPESAFE_API_KEY = "test-fake-key";
  try {
    const r = await call(c, "run_start", { repo, title, a_lines: ["A1 it works"] });
    if (r.isError) throw new Error(r.raw);
    return r.data as { run: string; dir: string };
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
}

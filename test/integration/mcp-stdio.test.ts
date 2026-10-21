import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { call } from "../mcp-helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
  version: string;
};

/** The environment a Claude Code session would start `catherd mcp` with, pointed at the simulator. */
function serverEnv(home: string, scenarioFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "TYPESAFE_API_KEY" && k !== "ANTHROPIC_API_KEY") env[k] = v;
  return {
    ...env,
    CATHERD_HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    PATH: simPath(),
    CATHERD_SIM_SCENARIO: scenarioFile,
    // a root container runs this suite too: preflight runs its checks there only on a disposable machine
    IS_SANDBOX: "1",
  };
}

const servers = new Map<Client, StdioClientTransport>();

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "claude-code", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env,
    stderr: "ignore",
  });
  await client.connect(transport);
  servers.set(client, transport);
  return client;
}

afterEach(async () => {
  for (const c of servers.keys()) await c.close();
  servers.clear();
});

describe("the server's environment", () => {
  it("never passes the user's Anthropic or TypeSafe key through", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    process.env.TYPESAFE_API_KEY = "tsk-fake";
    const env = serverEnv("/tmp/h", "/tmp/s.json");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
  });
});

describe("catherd mcp over stdio", () => {
  it("serves the six session tools, a status, a profile and a structured refusal", async () => {
    const home = withHome();
    delete process.env.TYPESAFE_API_KEY;
    tempRepo();
    const c = await connect(serverEnv(home, withScenario({}).file));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "answer",
      "cancel",
      "profile",
      "result",
      "run_start",
      "status",
    ]);
    const status = await call(c, "status");
    expect(status.data).toMatchObject({ version: PKG.version, runs: [], warnings: [] });
    expect((await call(c, "profile", { action: "get" })).data.profile.name).toBe("default");
    const refused = await call(c, "answer", { run: "nope", unit: "M1", answer: "x" });
    expect(refused.error).toMatchObject({ code: "E_RUN_NOT_FOUND" });
  }, 60_000);
});

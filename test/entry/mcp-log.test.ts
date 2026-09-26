import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { logFile } from "../../src/infra/log.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";

afterEach(snapshotEnv());

describe("the MCP server's log (spec §10.2)", () => {
  it("logs each tool call with its duration and outcome, never its input", async () => {
    withHome();
    delete process.env.CATHERD_LOG;
    const c = await mcpClient();
    await call(c, "status");
    await call(c, "status", { run: "secret-run-id-value" });
    const rows = readFileSync(logFile(), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    const tools = rows.filter((r) => r.event === "tool");
    expect(tools.map((r) => [r.tool, r.ok, r.code ?? null])).toEqual([
      ["status", true, null],
      ["status", false, "E_RUN_NOT_FOUND"],
    ]);
    expect(typeof tools[0].ms).toBe("number");
    expect(readFileSync(logFile(), "utf8")).not.toContain("secret-run-id-value");
  });
});

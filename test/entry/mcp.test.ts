import { afterEach, describe, expect, it } from "bun:test";
import { VERSION } from "../../src/infra/version.ts";
import { snapshotEnv } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, freshRun } from "../services/helpers.ts";

afterEach(snapshotEnv());

describe("MCP server", () => {
  it("lists exactly the six session tools", async () => {
    freshRun();
    const c = await mcpClient();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "answer",
      "cancel",
      "profile",
      "result",
      "run_start",
      "status",
    ]);
  });

  it("reports its version in status", async () => {
    freshRun();
    const r = await call(await mcpClient(), "status");
    expect(r.data.version).toBe(VERSION);
  });

  it("returns every failure as a structured { code, message, fix }", async () => {
    freshRun();
    const c = await mcpClient(fakeDeps());
    const r = await call(c, "answer", { run: "nope", unit: "M1", answer: "x" });
    expect(r.isError).toBe(true);
    expect(r.error).toEqual({
      code: "E_RUN_NOT_FOUND",
      message: 'no run "nope"',
      fix: "status() lists the runs",
    });
    expect(JSON.parse(r.raw)).toEqual(r.error);
  });

  it("returns input the tool schemas reject as a structured E_INPUT_INVALID", async () => {
    const { run } = freshRun();
    const c = await mcpClient(fakeDeps());
    const rejected = [
      await call(c, "run_start", { repo: "/r", title: "t", a_lines: [] }),
      await call(c, "answer", { run: run.id, unit: "", answer: "x" }),
      await call(c, "result", { run: run.id, name: "--x" }),
      await call(c, "profile", { action: "boil" }),
      // a tool of 1.5 is not on this server
      await call(c, "dispatch", { run: run.id }),
    ];
    for (const r of rejected) {
      expect(r.isError).toBe(true);
      expect(r.error?.code).toBe("E_INPUT_INVALID");
      expect(r.error?.fix).toBeTruthy();
      expect(JSON.parse(r.raw)).toEqual(r.error);
    }
    expect(rejected[0]?.error?.message).toContain("Input validation error");
  });
});

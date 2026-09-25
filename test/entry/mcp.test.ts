import { afterEach, describe, expect, it } from "bun:test";
import { progressTo } from "../../src/entry/mcp/dispatch-tools.ts";
import { VERSION } from "../../src/infra/version.ts";
import { snapshotEnv } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, fakeGit, freshRun, writeLane } from "../services/helpers.ts";

afterEach(snapshotEnv());

/** Spec §4.8, exactly. */
const TOOLS = [
  "run_start",
  "route",
  "preflight",
  "dispatch",
  "cancel",
  "climb",
  "ask",
  "land",
  "read_knowledge",
  "write_run_file",
  "read_run_file",
  "result",
  "status",
  "set_next",
  "record_agent_run",
  "runs_summary",
  "catalog_query",
  "profile_get",
  "profile_validate",
  "profile_set",
];

describe("MCP server", () => {
  it("lists exactly the 1.0 tools", async () => {
    freshRun();
    const c = await mcpClient();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  it("reports its version in status", async () => {
    freshRun();
    const r = await call(await mcpClient(), "status");
    expect(r.data.version).toBe(VERSION);
  });

  it("returns every failure as a structured { code, message, fix }", async () => {
    freshRun();
    const c = await mcpClient(fakeDeps());
    const r = await call(c, "dispatch", {
      run: "nope",
      role: "worker",
      name: "w",
      brief: "x",
      rung: "codex:a#b",
    });
    expect(r.isError).toBe(true);
    expect(r.error).toEqual({
      code: "E_RUN_NOT_FOUND",
      message: 'no run "nope"',
      fix: "status() lists the runs",
    });
    expect(JSON.parse(r.raw)).toEqual(r.error);
  });

  it("drives the run tools over the real server", async () => {
    const { run } = freshRun();
    const c = await mcpClient(fakeDeps());
    expect(
      (
        await call(c, "write_run_file", {
          run: run.id,
          path: "lanes/M1.L1.md",
          content: "# M1.L1\nOwns: a.ts\nFast check: true\n",
        })
      ).isError,
    ).toBe(false);
    expect((await call(c, "read_run_file", { run: run.id, path: "lanes/M1.L1.md" })).raw).toContain(
      "Owns: a.ts",
    );
    expect(
      (await call(c, "write_run_file", { run: run.id, path: "state.md", content: "" })).error?.code,
    ).toBe("E_IO_PATH");
    const set = await call(c, "set_next", { run: run.id, next: "paused: lunch" });
    expect(set.raw.trimEnd().split("\n").at(-1)).toBe("Next: paused: lunch");
    const agent = await call(c, "record_agent_run", {
      run: run.id,
      name: "architect",
      role: "architect",
      rung: "claude:claude-opus-5-5#high",
      total_tokens: 1200,
      duration_ms: 3000,
    });
    expect(agent.data).toMatchObject({ totalTokens: 1200, secs: 3 });
    expect((await call(c, "status", { run: run.id })).data.runs[0].agents.totalTokens).toBe(1200);
  });

  it("passes the services' hints through when state.md cannot be refreshed", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["a.ts"]);
    const c = await mcpClient(fakeDeps());
    expect((await call(c, "route", { run: run.id, lane_file: "lanes/M1.L1.md" })).isError).toBe(false);
    fakeGit("exit 128");
    const climbed = await call(c, "climb", { run: run.id, lane: "M1.L1", reason: "blocker" });
    expect(climbed.isError).toBe(false);
    expect(climbed.data.hints).toEqual([expect.stringMatching(/^state\.md not refreshed: /)]);
    const set = await call(c, "set_next", { run: run.id, next: "paused: lunch" });
    expect(set.isError).toBe(false);
    expect(set.raw).toMatch(/^state\.md not refreshed: /);
  });
});

describe("progress notifications", () => {
  it("never throw, whether the client rejects or the transport is closed", () => {
    const rejecting = progressTo("t", () => Promise.reject(new Error("client gone")));
    const throwing = progressTo(1, () => {
      throw new Error("closed");
    });
    expect(() => rejecting?.("w · 30s")).not.toThrow();
    expect(() => throwing?.("w · 30s")).not.toThrow();
    expect(progressTo(undefined, () => Promise.resolve())).toBeUndefined();
  });
});

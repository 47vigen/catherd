import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { progressTo } from "../../src/entry/mcp/dispatch-tools.ts";
import { gitToplevel } from "../../src/infra/git.ts";
import { VERSION } from "../../src/infra/version.ts";
import { readAgentRuns } from "../../src/services/run-store.ts";
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

  it("returns input the tool schemas reject as a structured E_INPUT_INVALID", async () => {
    const { run } = freshRun();
    const c = await mcpClient(fakeDeps());
    const base = { run: run.id, role: "worker", name: "w", brief: "x", rung: "codex:a#b" };
    const rejected = [
      await call(c, "dispatch", { ...base, name: "--x" }),
      await call(c, "dispatch", { ...base, role: "boss" }),
      await call(c, "land", {
        run: run.id,
        milestone: "M1",
        what: "w",
        commit: "HEAD",
        evidence: "e",
        next: "n",
      }),
    ];
    for (const r of rejected) {
      expect(r.isError).toBe(true);
      expect(r.error?.code).toBe("E_INPUT_INVALID");
      expect(r.error?.message).toContain("Input validation error");
      expect(r.error?.fix).toBeTruthy();
      expect(JSON.parse(r.raw)).toEqual(r.error);
    }
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
    const laned = await call(c, "record_agent_run", {
      run: run.id,
      name: "w",
      role: "worker",
      rung: "claude:claude-opus-5-5#high",
      total_tokens: 10,
      duration_ms: 1000,
      lane: "M1.L1",
    });
    expect(laned.data).toMatchObject({ lane: "M1.L1" });
    expect(readAgentRuns(run).at(-1)?.lane).toBe("M1.L1");
    expect(
      (
        await call(c, "record_agent_run", {
          run: run.id,
          name: "w",
          role: "worker",
          rung: "claude:claude-opus-5-5#high",
          total_tokens: 10,
          lane: "../x",
        })
      ).isError,
    ).toBe(true);
    expect((await call(c, "status", { run: run.id })).data.runs[0].agents.totalTokens).toBe(1210);
  });

  it("answers catalog_query from the repository's own opencode listing, as route reads it", async () => {
    const { repo } = freshRun();
    const top = (await gitToplevel(repo)) as string;
    const kimi = [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }];
    writeDiscovery("opencode", kimi, Date.parse("2026-09-25T10:00:00.000Z"), top);
    const c = await mcpClient();
    mkdirSync(join(repo, "sub"));
    const inRepo = await call(c, "catalog_query", { text: "kimi", repo: join(repo, "sub") });
    expect(inRepo.data.models.map((m: { model: string }) => m.model)).toEqual(["opencode-go/kimi-k3"]);
    const outside = await call(c, "catalog_query", {
      text: "kimi",
      repo: mkdtempSync(join(tmpdir(), "catherd-norepo-")),
    });
    expect(outside.data.total).toBe(0);
  });

  it("passes catalog_query the git toplevel of its repo, else of the server's directory", async () => {
    const { repo } = freshRun();
    const seen: (string | undefined)[] = [];
    const deps = fakeDeps();
    deps.routing.catalog = (f) => {
      seen.push(f.repo);
      return { total: 0, models: [] };
    };
    const c = await mcpClient(deps);
    await call(c, "catalog_query", { repo });
    await call(c, "catalog_query", {});
    await call(c, "catalog_query", { repo: mkdtempSync(join(tmpdir(), "catherd-norepo-")) });
    expect(seen).toEqual([
      (await gitToplevel(repo)) as string,
      (await gitToplevel(process.cwd())) ?? undefined,
      undefined,
    ]);
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

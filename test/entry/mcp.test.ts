import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { gitToplevel } from "../../src/infra/git.ts";
import { VERSION } from "../../src/infra/version.ts";
import { readAgentRuns } from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir, tempRepo } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, fakeGit, freshRun, writeLane } from "../services/helpers.ts";

afterEach(snapshotEnv());

/** The public MCP tools, including bounded orchestration waits. */
const TOOLS = [
  "run_start",
  "route",
  "preflight",
  "dispatch",
  "cancel",
  "peek",
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
  "catalog_sync",
  "profile_get",
  "profile_validate",
  "profile_set",
  "gate_check",
  "gate_pass",
  "park",
  "answer",
  "workspace_inspect",
  "workspace_start",
  "workspace_contract",
  "workspace_child_start",
  "workspace_status",
  "test_push",
  "workspace_budget",
  "workspace_pause",
  "workspace_resume",
  "lane_set",
  "owns_add",
  "run_pin",
];

describe("MCP server", () => {
  it("lists exactly the run and workspace tools, 38 of them", async () => {
    freshRun();
    const c = await mcpClient();
    expect(TOOLS).toHaveLength(38);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    const described = (name: string) =>
      c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
    // status is the verdict for a verifier: a FAIL recorded ok would open the land gate
    expect(await described("record_agent_run")).toContain('pass status: "failed" when its verdict is FAIL');
    expect(await described("land")).toContain("or a Claude subagent recorded with record_agent_run");
  });

  it("coordinates independent repository runs through workspace tools", async () => {
    freshRun();
    const root = tempDir("catherd-workspace-");
    const repos = { api: tempRepo(), web: tempRepo() };
    writeFileSync(join(root, "catherd.workspace.json"), JSON.stringify({ schema: 1, repos }));
    const c = await mcpClient(fakeDeps());
    const inspected = await call(c, "workspace_inspect", { root });
    expect(inspected.isError).toBe(false);
    expect(inspected.data).toEqual({ root, repos });
    const cli = (...args: string[]) =>
      Bun.spawnSync([process.execPath, new URL("../../src/cli.ts", import.meta.url).pathname, ...args], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const inspection = cli("workspace", "inspect", root, "--json");
    expect(inspection.exitCode).toBe(0);
    expect(JSON.parse(inspection.stdout.toString())).toEqual({ root, repos });
    const started = await call(c, "workspace_start", {
      root,
      title: "shared interface",
      a_lines: ["A1 both members work"],
      budget: { tokens: 10000 },
      steps: [
        { id: "api", repo: "api", title: "API", a_lines: ["A1 API works"], milestone: "M1" },
        { id: "web", repo: "web", title: "Web", a_lines: ["A1 UI works"], depends_on: ["api"] },
      ],
    });
    expect(started.isError).toBe(false);
    const workspace = started.data.workspace.id;
    expect(
      (await call(c, "workspace_contract", { workspace, content: "GET /items returns an array" })).isError,
    ).toBe(false);
    const initial = await call(c, "workspace_status", { workspace });
    expect(initial.data.steps.map((s: { state: string }) => s.state)).toEqual(["ready", "waiting"]);
    expect((await call(c, "workspace_child_start", { workspace, step: "web" })).isError).toBe(true);
    const child = await call(c, "workspace_child_start", { workspace, step: "api" });
    expect(child.isError).toBe(false);
    expect(child.data.run).toBeTruthy();
    expect(child.data.contract).toBe(join(child.data.dir, "workspace-contract.md"));
    expect((await call(c, "workspace_child_start", { workspace, step: "api" })).data.run).toBe(
      child.data.run,
    );
    expect(
      (await call(c, "read_run_file", { run: child.data.run, path: "workspace-contract.md" })).raw,
    ).toContain("GET /items");
    expect((await call(c, "workspace_contract", { workspace, content: "changed" })).isError).toBe(true);
    const active = await call(c, "workspace_status", { workspace });
    expect(active.data.steps[0]).toMatchObject({ state: "active", run: child.data.run });
    expect(active.data.budget.tokens.cap).toBe(10000);
    const raised = await call(c, "workspace_budget", { workspace, tokens: 20000, usd: 5 });
    expect(raised.data.budget).toEqual({ tokens: 20000, usd: 5 });
    expect((await call(c, "workspace_budget", { workspace, usd: null })).data.budget).toEqual({
      tokens: 20000,
    });
    const status = cli("workspace", "status", workspace, "--json");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).steps[0]).toMatchObject({
      state: "active",
      run: child.data.run,
    });
  });

  it("refuses a workspace step with an unknown key instead of dropping it (#43 finding 6)", async () => {
    freshRun();
    const root = tempDir("catherd-workspace-");
    const c = await mcpClient(fakeDeps());
    const r = await call(c, "workspace_start", {
      root,
      repos: { api: tempRepo(), web: tempRepo() },
      title: "camel case",
      a_lines: ["A1 web waits for api"],
      steps: [
        { id: "api", repo: "api", title: "API", a_lines: ["A1 API"] },
        { id: "web", repo: "web", title: "Web", a_lines: ["A1 Web"], dependsOn: ["api"] },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.raw).toContain("dependsOn");
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
      // a milestone becomes the digest's file name: an id, never a path
      await call(c, "land", {
        run: run.id,
        milestone: "../state",
        what: "w",
        commit: "abcdef1",
        evidence: "e",
        next: "n",
        skip: "no-code",
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
    const c = await mcpClient(fakeDeps(), "claude-code");
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
    expect(set.data.state.trimEnd().split("\n").at(-2)).toBe("Next: paused: lunch");
    expect(set.data.hints).toBeUndefined();
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
    expect(set.data).toEqual({ state: null, hints: [expect.stringMatching(/^state\.md not refreshed: /)] });
  });
});

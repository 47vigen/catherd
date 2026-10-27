import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../../src/domain/roles.ts";
import { buildRoleServer } from "../../src/entry/mcp/role-server.ts";
import { codexRoleMcpArgs, probeRoleServer, ROLE_MCP_STARTUP_SEC } from "../../src/infra/role-mcp.ts";
import { createRun } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { call } from "../mcp-helpers.ts";
import { fakeDeps, freshRun } from "../services/helpers.ts";

afterEach(snapshotEnv());

async function roleClient(run: string, role: Role): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await buildRoleServer({ run, role }, fakeDeps()).connect(serverSide);
  const client = new Client({ name: "role-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("the role server's start (spec 1.5 plan 21, #42 finding 8)", () => {
  it("gives Codex an explicit startup timeout, and starts cold well inside it", async () => {
    const args = codexRoleMcpArgs({ run: "20261002-101500-auth", role: "verifier" });
    expect(args).toContain("mcp_servers.catherd_role.required=true");
    expect(args).toContain(`mcp_servers.catherd_role.startup_timeout_sec=${ROLE_MCP_STARTUP_SEC}`);
    expect(ROLE_MCP_STARTUP_SEC).toBe(30);
    const start = await probeRoleServer();
    expect(start).toMatchObject({ ok: true });
    if (start.ok) expect(start.ms).toBeLessThan((ROLE_MCP_STARTUP_SEC * 1000) / 2);
    expect(await probeRoleServer(1)).toEqual({ ok: false, error: "no answer in 1 ms" });
  });
});

describe("dispatch-scoped role MCP", () => {
  it("exposes only each role's allowed tools", async () => {
    const { run } = freshRun();
    const cases: [Role, string[]][] = [
      ["worker", ["read_run_file", "read_knowledge", "team_send", "team_read", "team_wait"]],
      ["architect", ["read_run_file", "read_knowledge", "write_run_file", "team_send", "team_read"]],
      ["researcher", ["read_run_file", "read_knowledge", "write_run_file"]],
      ["verifier", ["read_run_file", "read_knowledge", "gate_check", "gate_pass", "gate_run"]],
    ];
    for (const [role, allowed] of cases) {
      const client = await roleClient(run.id, role);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(allowed.sort());
        expect((await call(client, "dispatch", { run: run.id })).isError).toBe(true);
      } finally {
        await client.close();
      }
    }
  });

  it("allows architect artifacts but rejects other runs, repositories and protected paths", async () => {
    const { repo, run } = freshRun();
    const other = createRun({
      repo: tempRepo(),
      title: "other",
      aLines: ["A1 works"],
      version: "0.0.0-test",
    });
    const client = await roleClient(run.id, "architect");
    try {
      expect(
        (await call(client, "write_run_file", { run: run.id, path: "plan.md", content: "# Plan" })).isError,
      ).toBe(false);
      expect((await call(client, "read_run_file", { run: run.id, path: "plan.md" })).raw).toContain("# Plan");
      expect(
        (await call(client, "write_run_file", { run: other.id, path: "plan.md", content: "wrong run" })).error
          ?.code,
      ).toBe("E_INPUT_INVALID");
      expect((await call(client, "read_run_file", { run: other.id, path: "plan.md" })).error?.code).toBe(
        "E_INPUT_INVALID",
      );
      // #42 finding 4: read_knowledge reads the run's own repository, whatever repo it is given
      const own = (await call(client, "read_knowledge", { repo })).raw;
      expect((await call(client, "read_knowledge", {})).raw).toBe(own);
      expect((await call(client, "read_knowledge", { repo: "." })).raw).toBe(own);
      expect((await call(client, "read_knowledge", { repo: other.meta.repo })).raw).toBe(own);
      for (const path of ["state.md", "../outside.md"])
        expect(
          (await call(client, "write_run_file", { run: run.id, path, content: "blocked" })).error?.code,
        ).toBe("E_IO_PATH");
      expect(existsSync(join(repo, "plan.md"))).toBe(false);
      expect(existsSync(join(other.dir, "plan.md"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("requires the milestone argument of gate_pass", async () => {
    const { run } = freshRun();
    const client = await roleClient(run.id, "verifier");
    try {
      const pass = (await client.listTools()).tools.find((tool) => tool.name === "gate_pass");
      expect(pass?.inputSchema.required).toContain("milestone");
      expect(
        (
          await call(client, "gate_pass", {
            run: run.id,
            item: "unit",
            command: "true",
            paths: ["."],
            evidence: "ok",
          })
        ).error?.code,
      ).toBe("E_INPUT_INVALID");
    } finally {
      await client.close();
    }
  });

  it("lists the verifier's own run's recorded items for a milestone, and only that run's (plan 23)", async () => {
    const { run } = freshRun();
    const other = createRun({
      repo: tempRepo(),
      title: "other",
      aLines: ["A1 works"],
      version: "0.0.0-test",
    });
    const client = await roleClient(run.id, "verifier");
    try {
      expect((await call(client, "gate_check", { run: run.id, milestone: "M1" })).data).toEqual({
        recorded: [],
        env: [],
      });
      expect((await call(client, "gate_check", { run: other.id, milestone: "M1" })).error?.code).toBe(
        "E_INPUT_INVALID",
      );
      expect((await call(client, "gate_check", { run: run.id })).error?.code).toBe("E_INPUT_INVALID");
    } finally {
      await client.close();
    }
  });

  it("runs the verifier's milestone check through gate_run, bound to its own run", async () => {
    const { run } = freshRun();
    const other = createRun({ repo: tempRepo(), title: "other", aLines: ["A1"], version: "0.0.0-test" });
    const client = await roleClient(run.id, "verifier");
    try {
      const r = await call(client, "gate_run", { run: run.id, milestone: "M1", command: "echo ok" });
      expect(r.error).toBeNull();
      expect(r.data).toMatchObject({ running: false, cached: false, record: { exit: 0 } });
      expect(
        (await call(client, "gate_run", { run: other.id, milestone: "M1", command: "echo ok" })).error?.code,
      ).toBe("E_INPUT_INVALID");
    } finally {
      await client.close();
    }
  });

  it("rejects another run before recording verifier gate evidence", async () => {
    const { run } = freshRun();
    const other = createRun({
      repo: tempRepo(),
      title: "other",
      aLines: ["A1 works"],
      version: "0.0.0-test",
    });
    const client = await roleClient(run.id, "verifier");
    try {
      for (const tool of ["gate_check", "gate_pass"])
        expect(
          (
            await call(client, tool, {
              run: other.id,
              item: "unit",
              command: "bun test",
              paths: ["src"],
              evidence: "passed",
            })
          ).error?.code,
        ).toBe("E_INPUT_INVALID");
      expect(
        (await call(client, "write_run_file", { run: run.id, path: "plan.md", content: "blocked" })).isError,
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});

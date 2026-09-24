import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendJsonl, appendRunRecord, createRun } from "../src/core/runstore.ts";
import { loadProfile } from "../src/profile/profile.ts";
import { tempRepo, withHome } from "./helpers.ts";
import { call, mcpClient } from "./mcp-helpers.ts";
import { fakeRecord } from "./records.ts";

let agents: string;

describe("setup tools", () => {
  beforeEach(() => {
    withHome();
    agents = mkdtempSync(join(tmpdir(), "catherd-agents-"));
    process.env.CATHERD_CLAUDE_AGENTS_DIR = agents;
  });

  test("catalog_query offers only capable models for a role, scored ones first", async () => {
    const c = await mcpClient();
    const r = await call(c, "catalog_query", { role: "ui-reviewer", limit: 500 });
    expect(r.data.total).toBeGreaterThan(0);
    for (const m of r.data.models) {
      expect(m.capabilities.imageIn).toBe(true);
      expect(m.roles).toContain("ui-reviewer");
      expect(typeof m.installed).toBe("boolean");
    }
    const sol = (await call(c, "catalog_query", { text: "gpt-6-sol" })).data.models[0];
    expect(sol.scored.map((e: { rung: string }) => e.rung)).toContain("gpt-6-sol#medium");
    expect((await call(c, "catalog_query", { limit: 3 })).data.models).toHaveLength(3);
  });

  test("profile_get returns the active profile and the names", async () => {
    const c = await mcpClient();
    const r = await call(c, "profile_get");
    expect(r.data.active).toBe("default");
    expect(r.data.profile.name).toBe("default");
    expect(Array.isArray(r.data.profiles)).toBe(true);
  });

  test("profile_set saves a valid patch, returns the diff and regenerates the agents", async () => {
    const c = await mcpClient();
    const r = await call(c, "profile_set", {
      patch: { objective: "speed", harness: { codex: { isolated: true } } },
    });
    expect(r.data.saved).toBe(true);
    expect(r.data.diff.map((d: { path: string[] }) => d.path.join("."))).toEqual(
      expect.arrayContaining(["objective", "harness.codex.isolated"]),
    );
    expect(loadProfile("default").objective).toBe("speed");
    expect(loadProfile("default").harness.codex.isolated).toBe(true);
    expect(readdirSync(agents).sort()).toEqual([
      "catherd-architect-claude-opus-5-5-high.md",
      "catherd-verifier-claude-opus-5-5-low.md",
    ]);
    expect(r.data.new_session_needed_for).toEqual([
      "catherd-architect-claude-opus-5-5-high",
      "catherd-verifier-claude-opus-5-5-low",
    ]);
    const again = await call(c, "profile_set", { patch: { objective: "cost" } });
    expect(again.data.new_session_needed_for).toEqual([]);
  });

  test("profile_set writes nothing when the patch is invalid", async () => {
    const c = await mcpClient();
    const r = await call(c, "profile_set", { patch: { roles: { worker: { models: {} } } } });
    expect(r.data.saved).toBe(false);
    expect(r.data.errors.length).toBeGreaterThan(0);
    expect(readdirSync(agents)).toEqual([]);
  });

  test("profile_validate reports the default profile as valid", async () => {
    const c = await mcpClient();
    expect((await call(c, "profile_validate")).data).toEqual({ valid: true, errors: [] });
  });

  test("runs_summary returns per-rung stats and the harness cost line", async () => {
    const c = await mcpClient();
    const run = createRun(tempRepo(), "a", []);
    appendRunRecord(run.dir, fakeRecord("worker-M1.L1"));
    appendJsonl(join(run.dir, "harness.jsonl"), {
      at: "x",
      name: "worker-M1.L1",
      backend: "codex",
      isolated: false,
      firstTurnInput: 40_000,
    });
    const r = await call(c, "runs_summary", { run: run.id });
    expect(r.data.rungs).toMatchObject([{ role: "worker", rung: "gpt-6-sol#medium", runs: 1 }]);
    expect(r.data.harness[0].line).toContain("median first-turn input ~40k tokens");
  });
});

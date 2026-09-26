import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatCheck } from "../../src/entry/doctor-command.ts";
import { VERSION } from "../../src/infra/version.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { withScenario } from "../sim/scenario.ts";
import { withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

function machine(): void {
  const home = withHome();
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = `${join(import.meta.dir, "..", "sim")}:${dirname(process.execPath)}:/usr/bin:/bin`;
  Object.assign(
    process.env,
    withScenario({ models: fx("codex/models.json"), sandbox: "allow" }).env,
    withClaudeScenario({}).env,
    withOpencodeScenario({ models: fx("opencode/models.json").data }).env,
  );
}

function doctor(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "doctor", ...args], {
    // Bun hands a child its own start-up env unless told otherwise; the test's CATHERD_HOME must reach it
    // blank: the claude-code listing is an HTTP call when the key is set, and tests never reach the network
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() };
}

describe("formatCheck", () => {
  it("prints the glyph, the word, the check and its detail, and the full fix on its own line", () => {
    expect(
      formatCheck({
        id: "backend:codex",
        label: "codex",
        state: "fail",
        word: "not logged in",
        detail: "codex is not logged in",
        fix: "codex login",
      }),
    ).toEqual(["✗ not logged in      codex — codex is not logged in", "    fix: codex login"]);
    expect(
      formatCheck({ id: "bun", label: "Bun", state: "ok", word: "ready", detail: "1.4.2" }, true),
    ).toEqual(["+ ready              Bun — 1.4.2"]);
  });
});

describe("catherd doctor", () => {
  it("exits 3 when not ready, and its JSON shows the real MCP server answering over stdio", () => {
    machine();
    const r = doctor("--json");
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out);
    expect(j.ready).toBe(false);
    expect(j.checks.find((c: { id: string }) => c.id === "plugin")).toMatchObject({
      state: "fail",
      word: "missing",
    });
    expect(j.checks.find((c: { id: string }) => c.id === "mcp")).toMatchObject({
      state: "ok",
      detail: "answers tools/list with 20 tools",
    });
  }, 60_000);

  it("exits 0 and says ready once the plugin is installed and the agents are linked", () => {
    machine();
    const plugins = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "catherd@catherd": [{ version: VERSION }] } }),
    );
    patchProfile("default", {});
    const r = doctor("--plain");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("+ ready");
    expect(r.out).toContain(
      "! no key             Jev — optional: routing uses each lane's Kind and Difficulty instead\n",
    );
  }, 60_000);
});

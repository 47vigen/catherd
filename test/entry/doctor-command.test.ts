import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mark } from "../../src/entry/cli-kit.ts";
import { formatCheck } from "../../src/entry/doctor-command.ts";
import { glyph } from "../../src/entry/tui/theme.ts";
import { logsDir } from "../../src/infra/paths.ts";
import { VERSION } from "../../src/infra/version.ts";
import { overridePath } from "../../src/services/catalog-service.ts";
import { credentialsPath } from "../../src/services/jev-service.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { withScenario } from "../sim/scenario.ts";
import { withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

const BARE_KEY = "tsk_FAKEKEY_DO_NOT_USE_1234567890";
/** Every 6-character piece of the pasted key that `text` contains: none, when nothing leaked. */
const keyPieces = (text: string): string[] =>
  Array.from({ length: BARE_KEY.length - 5 }, (_, i) => BARE_KEY.slice(i, i + 6)).filter((p) =>
    text.includes(p),
  );
const allLogs = (): string =>
  existsSync(logsDir())
    ? readdirSync(logsDir())
        .map((f) => readFileSync(join(logsDir(), f), "utf8"))
        .join("")
    : "";

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

describe("mark", () => {
  it("draws the theme's glyphs, ASCII under --plain (audit N2)", () => {
    for (const state of ["ok", "warn", "fail", "skip"] as const)
      for (const plain of [false, true]) expect(mark(state, plain)).toBe(glyph(state, plain));
  });
});

describe("catherd doctor", () => {
  it("keeps init's glyphs under NO_COLOR, which drops only colour; --plain is ASCII (audit N2)", () => {
    machine();
    process.env.NO_COLOR = "1";
    const text = doctor().out;
    expect(text).toContain("✓ ready              Bun");
    expect(text).not.toContain("+ ready");
    expect(doctor("--plain").out).toContain("+ ready              Bun");
  });

  it("never prints or logs a bare key pasted into credentials.json, and names the file (B1)", () => {
    machine();
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), `${BARE_KEY}\n`, { mode: 0o600 });
    const json = doctor("--json");
    const text = doctor("--plain");
    expect(keyPieces(json.out + text.out + allLogs())).toEqual([]);
    expect(JSON.parse(json.out).checks.find((c: { id: string }) => c.id === "credentials")).toMatchObject({
      state: "warn",
      detail: `${credentialsPath()} is not valid JSON`,
      fix: expect.stringContaining('"typesafeApiKey"'),
    });
    expect(allLogs()).toContain(`${credentialsPath()} is not valid JSON`);
  }, 60_000);

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
      detail: expect.stringMatching(/^answers tools\/list with \d+ tools$/),
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

  it("reports a corrupt catalog override as a fail row and exits 3, not 1", () => {
    machine();
    const plugins = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "catherd@catherd": [{ version: VERSION }] } }),
    );
    patchProfile("default", {});
    writeFileSync(overridePath(), "{ not json");
    const r = doctor("--json");
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).checks.find((c: { id: string }) => c.id === "profile")).toMatchObject({
      state: "fail",
      fix: `fix or delete ${overridePath()}`,
    });
  }, 60_000);
});

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { locksDir } from "../../src/infra/paths.ts";
import { VERSION } from "../../src/infra/version.ts";
import {
  type Check,
  type DoctorReport,
  doctor,
  type Handshake,
  PLUGIN_INSTALL,
} from "../../src/services/doctor.ts";
import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
import { configFile, patchProfile } from "../../src/services/profile-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { type CodexScenario, withScenario } from "../sim/scenario.ts";
import { type OpencodeScenario, withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const SIM = join(import.meta.dir, "..", "sim");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

/** A machine with the simulated CLIs `bins` on PATH (all three by default), the codex sandbox allowing writes. */
function machine(o: { codex?: CodexScenario; opencode?: OpencodeScenario; bins?: string[] } = {}): string {
  const home = withHome();
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const bin = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  for (const b of o.bins ?? ["codex", "claude", "opencode"]) symlinkSync(join(SIM, b), join(bin, b));
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  Object.assign(
    process.env,
    withScenario({ models: fx("codex/models.json"), sandbox: "allow", ...o.codex }).env,
    withClaudeScenario({}).env,
    withOpencodeScenario({ models: fx("opencode/models.json").data, ...o.opencode }).env,
  );
  return home;
}

function installPlugin(version: string): void {
  const dir = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "catherd@catherd": [{ scope: "user", version }] } }),
  );
}

const answers = async (): Promise<Handshake> => ({ ok: true, tools: ["status", "dispatch"] });
const run = (over: Partial<Parameters<typeof doctor>[0]> = {}) =>
  doctor({ bunVersion: "1.4.2", version: VERSION, handshake: answers, ...over });
const check = (r: DoctorReport, id: string): Check | undefined => r.checks.find((c) => c.id === id);
const states = (r: DoctorReport) => Object.fromEntries(r.checks.map((c) => [c.id, `${c.state} ${c.word}`]));

/** A machine where everything the default profile needs works, and the agents are linked. */
function ready(): string {
  const home = machine();
  installPlugin(VERSION);
  patchProfile("default", {});
  return home;
}

describe("doctor", () => {
  it("is ready when everything the active profile needs works, warning only on what is optional", async () => {
    ready();
    const r = await run();
    expect(r.ready).toBe(true);
    expect(states(r)).toEqual({
      bun: "ok ready",
      config: "ok ready",
      profile: "ok ready",
      "backend:codex": "ok ready",
      "backend:claude-code": "ok ready",
      "backend:opencode": "ok ready",
      jev: "warn no key",
      plugin: "ok ready",
      agents: "ok ready",
      mcp: "ok ready",
      locks: "ok ready",
      "sandbox:codex": "ok ready",
      "access:full": "warn warning",
      "access:advisory": "warn warning",
    });
    expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · \d+ models$/);
    expect(check(r, "agents")?.detail).toBe("2 linked");
    expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
  });

  it("fails on a backend a role runs on, but only warns on one a failover stand-in alone uses", async () => {
    ready();
    process.env.PATH = process.env.PATH?.replace(/^[^:]+/, (bin) => {
      const only = mkdtempSync(join(tmpdir(), "catherd-bin-"));
      symlinkSync(join(bin, "claude"), join(only, "claude"));
      return only;
    });
    const r = await run();
    expect(r.ready).toBe(false);
    expect(check(r, "backend:codex")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: "npm i -g @openai/codex",
    });
    expect(check(r, "backend:opencode")).toMatchObject({
      state: "warn",
      word: "missing",
      detail: "opencode is not on PATH (a failover stand-in uses it)",
    });
  });

  it("names the login a backend needs", async () => {
    machine({ codex: { loggedIn: false } });
    installPlugin(VERSION);
    patchProfile("default", {});
    expect(check(await run(), "backend:codex")).toMatchObject({
      state: "fail",
      word: "not logged in",
      fix: "codex login",
    });
  });

  it("fails without the plugin, or with a plugin of another version", async () => {
    machine();
    patchProfile("default", {});
    expect(check(await run(), "plugin")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: PLUGIN_INSTALL,
    });
    installPlugin("0.9.0");
    expect(check(await run(), "plugin")).toMatchObject({
      state: "fail",
      word: "stale",
      detail: `plugin 0.9.0, catherd ${VERSION}`,
    });
  });

  it("fails on missing agent links, with the command that relinks them", async () => {
    machine();
    installPlugin(VERSION);
    expect(check(await run(), "agents")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: "catherd profile use default",
    });
  });

  it("fails when the MCP server does not answer tools/list", async () => {
    ready();
    const r = await run({
      handshake: async () => ({ ok: false, tools: [], error: "no answer within 20 s" }),
    });
    expect([r.ready, check(r, "mcp")?.detail]).toEqual([false, "no answer within 20 s"]);
  });

  it("warns, with the fix, when a Codex workspace-write sandbox cannot write the lock dir; skips when it cannot test", async () => {
    machine({ codex: { sandbox: "deny" } });
    installPlugin(VERSION);
    patchProfile("default", {});
    const denied = check(await run(), "sandbox:codex");
    expect(denied).toMatchObject({ state: "warn", word: "not writable" });
    expect(denied?.fix).toBe(
      `add "${locksDir()}" to writable_roots under [sandbox_workspace_write] in ~/.codex/config.toml`,
    );
    machine({ codex: { sandbox: undefined } });
    installPlugin(VERSION);
    patchProfile("default", {});
    expect(check(await run(), "sandbox:codex")).toMatchObject({ state: "skip", word: "not tested" });
  });

  it("tests a Jev key, and skips Jev when the profile turns it off", async () => {
    ready();
    saveJevKey("tsk-test-key-0123456789");
    const good = fakeFetch({ status: 200, body: { data: [] } });
    expect(check(await run({ jev: { fetchImpl: good.impl } }), "jev")).toMatchObject({
      state: "ok",
      word: "ready",
    });
    const bad = fakeFetch({ status: 401, body: { error: "bad key" } });
    expect(check(await run({ jev: { fetchImpl: bad.impl } }), "jev")).toMatchObject({
      state: "warn",
      word: "no answer",
    });
    patchProfile("default", { jev: { use: "off" } });
    expect(check(await run(), "jev")).toMatchObject({ state: "skip", word: "off" });
  });

  it("fails on a credentials file others can read", async () => {
    ready();
    saveJevKey("tsk-test-key-0123456789");
    chmodSync(credentialsPath(), 0o644);
    expect(check(await run(), "credentials")).toMatchObject({
      state: "fail",
      word: "readable by others",
      fix: `chmod 600 ${credentialsPath()}`,
    });
  });

  it("fails on an old Bun, an invalid profile, and a 0.x config", async () => {
    ready();
    expect(check(await run({ bunVersion: "1.3.11" }), "bun")).toMatchObject({
      state: "fail",
      word: "too old",
      fix: "bun upgrade",
    });
    const doc = JSON.parse(readFileSync(join(dirname(configFile()), "profiles", "default.json"), "utf8"));
    writeFileSync(
      join(dirname(configFile()), "profiles", "default.json"),
      JSON.stringify({ ...doc, roles: { ...doc.roles, worker: { ...doc.roles.worker, enabled: false } } }),
    );
    expect(check(await run(), "profile")).toMatchObject({ state: "fail", word: "invalid" });
    writeFileSync(configFile(), JSON.stringify({ activeProfile: "default" }));
    expect(check(await run(), "config")).toMatchObject({
      state: "fail",
      fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
    });
  });
});

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realTmpdir } from "../../src/adapters/access.ts";
import { claudeAgentsDir, indexPath, locksDir } from "../../src/infra/paths.ts";
import { readIndexFile, writeIndexFile } from "../../src/infra/slopalytics.ts";
import { runProbes } from "../../src/services/doctor-access.ts";
import { VERSION } from "../../src/infra/version.ts";
import { accessRepos, type DoctorReport, doctor, type Handshake } from "../../src/services/doctor.ts";
import { type Check, indexCheck, PLUGIN_INSTALL } from "../../src/services/doctor-checks.ts";
import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
import { activate, createProfile, patchProfile } from "../../src/services/profile-service.ts";
import { configFile, profilesDir, projectsFile } from "../../src/services/profile-store.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { type CodexScenario, withScenario } from "../sim/scenario.ts";
import {
  type CursorScenario,
  type OpencodeScenario,
  withClaudeScenario,
  withCursorScenario,
  withOpencodeScenario,
} from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

/** What the HTTPS probe reaches in tests: a local server, so no test leaves the machine. */
const ping = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("{}"),
});
afterAll(() => ping.stop(true));

/** The simulator bin folders a test made, removed after it. */
const bins: string[] = [];
const binDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  bins.push(d);
  return d;
};
afterEach(() => {
  for (const d of bins.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const SIM = join(import.meta.dir, "..", "sim");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

/**
 * A machine with the simulated CLIs `bins` on PATH (all three by default) and a stub agent-browser (unless
 * `agentBrowser` is false), the codex sandbox allowing writes.
 */
function machine(
  o: {
    codex?: CodexScenario;
    opencode?: OpencodeScenario;
    cursor?: CursorScenario;
    bins?: string[];
    agentBrowser?: boolean;
  } = {},
): string {
  const home = withHome();
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const bin = binDir();
  for (const b of o.bins ?? ["codex", "claude", "opencode"]) symlinkSync(join(SIM, b), join(bin, b));
  if (o.agentBrowser !== false) writeFileSync(join(bin, "agent-browser"), "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.CATHERD_PROBE_URL = `http://127.0.0.1:${ping.port}/-/ping`;
  process.env.CATHERD_PROBE_DOCKER = "catherd-no-docker";
  Object.assign(
    process.env,
    withScenario({
      models: fx("codex/models.json"),
      sandbox: "allow",
      ...o.codex,
    }).env,
    withClaudeScenario({}).env,
    withOpencodeScenario({
      models: fx("opencode/models.json").data,
      ...o.opencode,
    }).env,
    withCursorScenario({
      modelsFile: join(FX, "cursor", "models.txt"),
      ...o.cursor,
    }).env,
  );
  delete process.env.CURSOR_API_KEY;
  return home;
}

function installPlugin(version: string): void {
  const dir = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "catherd@catherd": [{ scope: "user", version }] },
    }),
  );
}

const answers = async (): Promise<Handshake> => ({
  ok: true,
  tools: ["status", "dispatch"],
});
/** Jev answers from a fake: a test that saves a key must never reach the real API. */
const offlineJev = () => ({
  fetchImpl: fakeFetch({ status: 200, body: { data: [] } }).impl,
});
const run = (over: Partial<Parameters<typeof doctor>[0]> = {}) =>
  doctor({
    host: { host: "claude-code", session: null, conflict: null },
    repo: null,
    bunVersion: "1.4.2",
    version: VERSION,
    handshake: answers,
    jev: offlineJev(),
    ...over,
  });
const check = (r: DoctorReport, id: string): Check | undefined => r.checks.find((c) => c.id === id);
const states = (r: DoctorReport) => Object.fromEntries(r.checks.map((c) => [c.id, `${c.state} ${c.word}`]));

/** A machine where everything the default profile needs works, and the agents are linked. */
function ready(): string {
  const home = machine();
  installPlugin(VERSION);
  patchProfile("default", {}, { host: "claude-code" });
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
      "role-mcp:default:claude-code": "info configured",
      "role-mcp:default:codex": "info configured",
      "backend:codex": "ok ready",
      "backend:claude-code": "ok ready",
      "backend:opencode": "ok ready",
      "backend:cursor": "skip missing",
      jev: "warn no key",
      catalog: "ok fresh",
      plugin: "ok ready",
      agents: "ok ready",
      mcp: "ok ready",
      locks: "ok ready",
      // the toolchain caches this machine has: none, or some, all writable
      caches: expect.stringMatching(/^(ok ready|skip none)$/),
      "sandbox:codex": "ok ready",
      "access:codex": "ok ready",
      "access:opencode": "ok ready",
      "access:full": "info default",
      "access:advisory": "info default",
    });
    expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · ChatGPT login · \d+ models$/);
    expect(check(r, "agents")?.detail).toBe("2 linked");
    expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
  });

  it("shows Cursor's CLI with its version, login and listing, and an agent on PATH that is not Cursor as info", async () => {
    machine({ bins: ["codex", "claude", "opencode", "cursor-agent"] });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const bin = process.env.PATH?.split(":")[0] as string;
    writeFileSync(join(bin, "agent"), "#!/bin/sh\necho 'agent 1.0 (a build agent)'\n");
    chmodSync(join(bin, "agent"), 0o755);
    const r = await run();
    expect(check(r, "backend:cursor")).toMatchObject({
      state: "ok",
      word: "ready",
      detail: "2026.09.28 · Cursor login · 8 models",
    });
    expect(check(r, "name:agent")).toMatchObject({
      label: "agent",
      state: "info",
      detail: expect.stringContaining("another program than cursor-agent"),
    });
    expect(r.ready).toBe(true);
  });

  it("fails a logged-out Cursor a role runs on, with the login fix", async () => {
    machine({
      bins: ["codex", "claude", "opencode", "cursor-agent"],
      cursor: { loggedIn: false },
    });
    installPlugin(VERSION);
    // Composer is unscored: its inferred stand-ins let the role run (spec 1.3 §7.2)
    const saved = patchProfile(
      "default",
      { roles: { writer: { rungs: ["cursor:gpt-6-sol#high"] } } },
      { host: "claude-code" },
    );
    expect(saved.saved).toBe(true);
    const r = await run();
    expect(check(r, "backend:cursor")).toMatchObject({
      state: "fail",
      word: "not logged in",
      fix: "cursor-agent login, or export CURSOR_API_KEY=<key>",
    });
  });

  it("fails on a backend a role runs on, but only warns on one a failover stand-in alone uses", async () => {
    ready();
    process.env.PATH = process.env.PATH?.replace(/^[^:]+/, (bin) => {
      const only = binDir();
      symlinkSync(join(bin, "claude"), join(only, "claude"));
      return only;
    });
    const r = await run();
    expect(r.ready).toBe(false);
    expect(check(r, "backend:codex")).toMatchObject({
      state: "fail",
      word: "missing",
    });
    expect(check(r, "backend:codex")?.fix).toStartWith(
      "npm i -g @openai/codex\nor move its roles to claude-code",
    );
    expect(check(r, "backend:opencode")).toMatchObject({
      state: "warn",
      word: "missing",
      detail: "opencode is not on PATH (a failover stand-in uses it)",
    });
  });

  it("offers to move a missing Codex's roles to claude-code when that is ready, one command a line", async () => {
    machine({ bins: ["claude"] });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const to = (role: string) =>
      `catherd profile set roles.${role}.rungs 'claude-code:claude-opus-5-5#medium' --profile default --host claude-code`;
    expect(check(await run(), "backend:codex")?.fix?.split("\n")).toEqual([
      "npm i -g @openai/codex",
      "or move its roles to claude-code: /catherd-setup in Claude Code, or run (artist needs codex, so it is turned off)",
      "catherd profile set roles.worker.defaultRung null --profile default --host claude-code",
      to("worker"),
      to("reviewer"),
      to("ui-reviewer"),
      "catherd profile set roles.artist.enabled false --profile default --host claude-code",
      to("writer"),
      to("researcher"),
    ]);
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
  it("prints move commands a shell runs as they are, after which no role needs the missing Codex", async () => {
    machine({ bins: ["claude"] });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const fix = check(await run(), "backend:codex")?.fix ?? "";
    const commands = fix.split("\n").filter((l) => l.startsWith("catherd "));
    expect(commands.length).toBeGreaterThan(0);
    const bin = binDir();
    const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
    writeFileSync(join(bin, "catherd"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`);
    chmodSync(join(bin, "catherd"), 0o755);
    const env = {
      ...process.env,
      CATHERD_ORCHESTRATION_HOST: "claude-code",
      PATH: `${bin}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: "",
    };
    for (const c of commands) {
      const p = Bun.spawnSync(["sh", "-c", c], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ c, exit: p.exitCode, err: p.stderr.toString() }).toEqual({
        c,
        exit: 0,
        err: "",
      });
    }
    const after = await run();
    // stale failover entries may warn; nothing blocks a save
    expect(check(after, "profile")?.state).not.toBe("fail");
    expect(check(after, "backend:codex")?.state).not.toBe("fail");
    expect(after.ready).toBe(true);
  }, 30_000);

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
  it("resets a customised default rung the moved ladder would not hold, so every printed command runs", async () => {
    machine({ bins: ["claude"] });
    installPlugin(VERSION);
    const saved = patchProfile(
      "default",
      {
        roles: {
          worker: {
            rungs: ["codex:gpt-6-sol#medium", "claude-code:claude-opus-5-5#high"],
            defaultRung: "claude-code:claude-opus-5-5#high",
          },
        },
      },
      { host: "claude-code" },
    );
    expect(saved.saved).toBe(true);
    const fix = check(await run(), "backend:codex")?.fix ?? "";
    const commands = fix.split("\n").filter((l) => l.startsWith("catherd "));
    expect(commands).toContain(
      "catherd profile set roles.worker.defaultRung null --profile default --host claude-code",
    );
    const bin = binDir();
    const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
    writeFileSync(join(bin, "catherd"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`);
    chmodSync(join(bin, "catherd"), 0o755);
    const env = {
      ...process.env,
      CATHERD_ORCHESTRATION_HOST: "claude-code",
      PATH: `${bin}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: "",
    };
    for (const c of commands) {
      const p = Bun.spawnSync(["sh", "-c", c], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ c, exit: p.exitCode, err: p.stderr.toString() }).toEqual({
        c,
        exit: 0,
        err: "",
      });
    }
    expect((await run()).ready).toBe(true);
  }, 30_000);

  it("offers opencode when it is the backend that is ready", async () => {
    machine({ bins: ["opencode"] });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const fix = check(await run(), "backend:codex")?.fix ?? "";
    expect(fix).toContain("or move its roles to opencode: /catherd-setup in Claude Code, or run");
    expect(fix).toContain(
      "\ncatherd profile set roles.worker.rungs 'opencode:opencode-go/gpt-6-luna#high' --profile default --host claude-code\n",
    );
  });

  it("offers only the install when no other backend is ready", async () => {
    machine({ bins: [] });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    expect(check(await run(), "backend:codex")?.fix).toBe("npm i -g @openai/codex");
  });

  it("names the login a backend needs", async () => {
    machine({ codex: { loggedIn: false } });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    expect(check(await run(), "backend:codex")).toMatchObject({
      state: "fail",
      word: "not logged in",
      fix: "codex login",
    });
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
  it("says how Codex is logged in, and warns when a profile bills that login as something else", async () => {
    machine({ codex: { login: "api-key" } });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const r = await run();
    expect(check(r, "backend:codex")).toMatchObject({
      state: "warn",
      word: "billing",
      detail: expect.stringMatching(
        /^0\.157\.0 · API key login · profile default bills codex as chatgpt-plan, but this login is metered/,
      ),
      fix: "catherd profile set billing.codex metered --profile default --host claude-code",
    });
    expect(JSON.stringify(r)).not.toContain("sk-proj");
    patchProfile("default", { billing: { codex: "metered" } }, { host: "claude-code" });
    expect(check(await run(), "backend:codex")).toMatchObject({
      state: "ok",
      word: "ready",
    });
  }, 30_000);

  it("does not warn about the Codex login's billing when no profile routes anything to Codex", async () => {
    machine({ codex: { login: "api-key" } });
    installPlugin(VERSION);
    const claude = { rungs: ["claude:claude-opus-5-5#medium"] };
    const r0 = patchProfile(
      "default",
      {
        roles: {
          worker: { ...claude, defaultRung: "claude:claude-opus-5-5#medium" },
          reviewer: claude,
          "ui-reviewer": claude,
          artist: { enabled: false },
          writer: claude,
          researcher: claude,
        },
      },
      { host: "claude-code" },
    );
    expect(r0).toMatchObject({ saved: true, errors: [] });
    const r = await run();
    expect(check(r, "backend:codex")).toMatchObject({
      state: "ok",
      word: "ready",
    });
    expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · API key login/);
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
  it("fails without the plugin, or with a plugin of another version", async () => {
    machine();
    patchProfile("default", {}, { host: "claude-code" });
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
  }, 30_000);

  it("fails on missing agent links, with the command that relinks them", async () => {
    machine();
    installPlugin(VERSION);
    expect(check(await run(), "agents")).toMatchObject({
      state: "fail",
      word: "missing",
      fix: "catherd profile use default --host claude-code",
    });
  });

  it("relinks the repo's bound profile, on doctor's host, when its agent links are missing", async () => {
    machine();
    installPlugin(VERSION);
    createProfile("team", undefined, "claude-code");
    const repo = tempRepo();
    activate("team", repo, "claude-code");
    for (const link of readdirSync(claudeAgentsDir())) rmSync(join(claudeAgentsDir(), link));
    expect(check(await run({ repo }), "agents")).toMatchObject({
      state: "fail",
      fix: `cd ${repo} && catherd profile use team --repo --host claude-code`,
    });
  });

  it("shows the shipped defaults' access as info, and warns only on what a profile changed (spec 1.1 §13)", async () => {
    ready();
    patchProfile(
      "default",
      {
        roles: {
          reviewer: { access: "full" },
          worker: {
            rungs: ["codex:gpt-6-sol#medium", "opencode:opencode-go/gpt-6-luna#high"],
          },
        },
      },
      { host: "claude-code" },
    );
    const r = await run();
    expect(check(r, "access:full")).toEqual({
      id: "access:full",
      label: "full access",
      state: "warn",
      word: "warning",
      detail: "no sandbox for: reviewer (default); as shipped: verifier (default), ui-reviewer (default)",
    });
    expect(check(r, "access:advisory")).toMatchObject({
      state: "warn",
      word: "warning",
      detail: expect.stringMatching(
        /^the backend asks but cannot force: worker on opencode \(default\); as shipped: /,
      ),
    });
  });

  it("keeps the probe rows apart from the info rows, before them, and info never counts against ready (R3, R4)", async () => {
    ready();
    const r = await run();
    const ids = r.checks.map((c) => c.id);
    const at = (id: string) => ids.indexOf(id);
    expect(at("locks")).toBeLessThan(at("sandbox:codex"));
    expect(at("sandbox:codex")).toBeLessThan(at("access:codex"));
    expect(at("access:opencode")).toBeLessThan(at("access:full"));
    expect(at("access:full")).toBeLessThan(at("access:advisory"));
    // Runtime probes are distinct from static role MCP policy, shipped access defaults and the catalog row.
    expect(r.checks.filter((c) => c.state === "info").map((c) => c.id)).toEqual([
      "role-mcp:default:codex",
      "role-mcp:default:claude-code",
      "access:full",
      "access:advisory",
    ]);
    // info is not a warning and not a failure: the report is ready, and doctor --json says "info"
    expect(r.ready).toBe(true);
    const json = JSON.parse(JSON.stringify(r)) as DoctorReport;
    expect(json.ready).toBe(true);
    expect(json.checks.find((c) => c.id === "access:full")?.state).toBe("info");
    expect(r.checks.filter((c) => c.state === "warn").map((c) => c.id)).toEqual(["jev"]);
  });

  it("fails when the MCP server does not answer tools/list", async () => {
    ready();
    const r = await run({
      handshake: async () => ({
        ok: false,
        tools: [],
        error: "no answer within 20 s",
      }),
    });
    expect([r.ready, check(r, "mcp")?.detail]).toEqual([false, "no answer within 20 s"]);
  });

  it("says to reinstall when the server cannot load a module (spec 1.1 §12)", async () => {
    ready();
    const r = await run({
      handshake: async () => ({
        ok: false,
        tools: [],
        error: "MCP error -32000: Connection closed",
        stderr:
          "error: Cannot find module '@modelcontextprotocol/sdk/server/mcp.js' from '/c/bunx/src/x.ts'\n",
      }),
    });
    expect(check(r, "mcp")).toEqual({
      id: "mcp",
      label: "MCP server",
      state: "fail",
      word: "broken install",
      detail: `cannot load @modelcontextprotocol/sdk/server/mcp.js; reinstall: bun add -g catherd-cli@${VERSION}`,
      fix: `bun add -g catherd-cli@${VERSION}`,
    });
  });

  it("says to install catherd when the launcher finds neither it nor bunx", async () => {
    ready();
    const r = await run({
      handshake: async () => ({
        ok: false,
        tools: [],
        error: "MCP error -32000: Connection closed",
        stderr: "/p/bin/catherd-mcp: 17: exec: bunx: not found\n",
      }),
    });
    expect(check(r, "mcp")).toMatchObject({
      state: "fail",
      word: "missing",
      detail: `no catherd ${VERSION} on PATH and no bunx to fetch it; reinstall: bun add -g catherd-cli@${VERSION}`,
      fix: `bun add -g catherd-cli@${VERSION}`,
    });
  });

  it("runs the five access probes in codex sandbox with the grants a worker gets (spec §5, §12)", async () => {
    const argsTo = join(binDir(), "sandbox-args.jsonl");
    machine({ codex: { sandboxArgsTo: argsTo } });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const r = await run();
    expect(check(r, "sandbox:codex")).toMatchObject({
      state: "ok",
      detail: "codex sandbox",
    });
    expect(check(r, "access:codex")).toMatchObject({
      state: "ok",
      detail: "lock-dir write, temp write, loopback bind, outbound HTTPS in codex sandbox · no docker",
    });
    const calls = readFileSync(argsTo, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    // `true` first, then lock, temp, loopback and HTTPS (docker is not installed here)
    expect(calls).toHaveLength(5);
    // Codex's runner takes an argv, so the probe goes split, not as one quoted line
    expect(calls[1]?.slice(calls[1].indexOf("--") + 1)).toEqual([
      "sh",
      "-c",
      'f="$1/.catherd-doctor-$$" && touch "$f" && rm -f "$f"',
      "_",
      locksDir(),
    ]);
    for (const c of calls) {
      expect(c).toContain("sandbox_workspace_write.network_access=true");
      expect(
        c.some((a) => a.startsWith("sandbox_workspace_write.writable_roots=") && a.includes(locksDir())),
      ).toBe(true);
    }
  });

  it("runs the five access probes through `cursor-agent sandbox run`, which re-shells its args (spec 1.3 §4.7)", async () => {
    machine({ bins: ["codex", "claude", "opencode", "cursor-agent"] });
    installPlugin(VERSION);
    const bin = process.env.PATH?.split(":")[0] as string;
    const ran = join(bin, "docker-ran");
    writeFileSync(join(bin, "fake-docker"), `#!/bin/sh\necho "$@" > '${ran}'\n`);
    chmodSync(join(bin, "fake-docker"), 0o755);
    process.env.CATHERD_PROBE_DOCKER = join(bin, "fake-docker");
    patchProfile(
      "default",
      { roles: { writer: { rungs: ["cursor:gpt-6-sol#high"] } } },
      { host: "claude-code" },
    );
    const r = await run();
    expect(check(r, "access:cursor")).toMatchObject({
      state: "ok",
      detail:
        "lock-dir write, temp write, loopback bind, outbound HTTPS, docker version in Cursor's sandbox (cursor-agent sandbox run)",
    });
    // docker really ran, not an empty `sh -c` that exits 0
    expect(readFileSync(ran, "utf8")).toBe("version\n");
  });

  it("warns with a fix per probe the Codex sandbox blocks", async () => {
    machine({ codex: { sandboxDeny: ["Bun.listen", "fetch("] } });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const c = check(await run(), "access:codex");
    expect(c).toMatchObject({ state: "warn", word: "blocked" });
    expect(c?.detail).toStartWith("in codex sandbox, a worker cannot: loopback bind (");
    expect(c?.detail).toContain("; outbound HTTPS (");
    expect(c?.fix?.split("\n")).toEqual([
      expect.stringMatching(/^loopback bind: catherd passes this grant to Codex itself/),
      expect.stringMatching(/^outbound HTTPS: catherd passes this grant to Codex itself/),
    ]);
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
  it("falls back to the old codex sandbox form, and skips when neither form runs", async () => {
    machine({ codex: { sandboxForm: "old" } });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const r = await run();
    expect(check(r, "sandbox:codex")?.detail).toEndWith("--full-auto (the old form)");
    expect(check(r, "access:codex")?.state).toBe("ok");
    machine({ codex: { sandbox: undefined } });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const none = await run();
    expect(check(none, "sandbox:codex")).toMatchObject({
      state: "skip",
      word: "not tested",
    });
    expect(check(none, "access:codex")).toMatchObject({
      state: "skip",
      word: "not tested",
    });
  }, 30_000);

  it("probes no network for roles whose network is off, and says opencode cannot enforce it", async () => {
    const argsTo = join(binDir(), "sandbox-args.jsonl");
    machine({ codex: { sandboxArgsTo: argsTo } });
    installPlugin(VERSION);
    patchProfile(
      "default",
      {
        roles: {
          worker: { network: false },
          writer: { network: false },
          artist: { network: false },
        },
      },
      { host: "claude-code" },
    );
    const r = await run();
    expect(check(r, "access:codex")?.detail).toBe(
      "lock-dir write, temp write in codex sandbox · network off by profile",
    );
    const probed = readFileSync(argsTo, "utf8");
    expect(probed).toContain("sandbox_workspace_write.network_access=false");
    expect(probed).not.toContain("sandbox_workspace_write.network_access=true");
    expect(check(r, "access:opencode")?.detail).toContain(
      "network: false is not enforced by opencode's shell",
    );
  });

  it("runs no docker probe for a backend whose workspace-write roles all have network off", async () => {
    machine();
    const marker = join(binDir(), "docker-ran");
    const fake = join(binDir(), "fake-docker");
    writeFileSync(
      fake,
      `#!/bin/sh\ntouch ${marker}\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n`,
    );
    chmodSync(fake, 0o755);
    process.env.CATHERD_PROBE_DOCKER = fake;
    installPlugin(VERSION);
    patchProfile(
      "default",
      {
        roles: {
          worker: { network: false },
          writer: { network: false },
          artist: { network: false },
        },
      },
      { host: "claude-code" },
    );
    const c = check(await run(), "access:codex");
    expect(c).toMatchObject({
      state: "ok",
      word: "ready",
      detail: "lock-dir write, temp write in codex sandbox · network off by profile",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("warns when docker is installed but does not answer", async () => {
    machine();
    const fake = join(binDir(), "fake-docker");
    writeFileSync(fake, "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    process.env.CATHERD_PROBE_DOCKER = fake;
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const c = check(await run(), "access:opencode");
    expect(c).toMatchObject({ state: "warn", word: "blocked" });
    expect(c?.detail).toContain("docker version (Cannot connect to the Docker daemon)");
    expect(c?.fix).toBe(`docker version: start Docker: ${fake} version fails`);
  });

  it("still reports when the lock dir cannot be created: the lock probe row fails with the error", async () => {
    machine();
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    mkdirSync(dirname(locksDir()), { recursive: true });
    writeFileSync(locksDir(), "not a dir");
    const r = await run();
    expect(check(r, "locks")).toMatchObject({
      state: "fail",
      word: "not writable",
    });
    const c = check(r, "access:opencode");
    expect(c).toMatchObject({ state: "warn", word: "blocked" });
    expect(c?.detail).toContain("lock-dir write (cannot create");
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
  it("skips the access probes of a backend that is not installed, and runs none of them", async () => {
    machine({ bins: ["codex", "claude"] });
    const marker = join(binDir(), "docker-ran");
    const fake = join(binDir(), "fake-docker");
    writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(fake, 0o755);
    process.env.CATHERD_PROBE_DOCKER = fake;
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const r = await run();
    expect(check(r, "access:opencode")).toMatchObject({
      state: "skip",
      word: "not installed",
      detail: "opencode is not installed: no worker runs on it here",
    });
    // codex is installed: its probes still run
    expect(check(r, "access:codex")?.state).toBe("ok");
    rmSync(marker, { force: true });
    machine({ bins: ["claude"] });
    process.env.CATHERD_PROBE_DOCKER = fake;
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const none = await run();
    expect(check(none, "access:codex")?.word).toBe("not installed");
    expect(check(none, "sandbox:codex")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("names a failed probe by its last stderr line, not stdout's or Bun's version trailer", async () => {
    machine();
    const fake = join(binDir(), "fake-docker");
    writeFileSync(
      fake,
      "#!/bin/sh\necho 'Client:' \necho ' Context: default'\necho 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' >&2\nexit 1\n",
    );
    chmodSync(fake, 0o755);
    process.env.CATHERD_PROBE_DOCKER = fake;
    process.env.CATHERD_PROBE_URL = "http://127.0.0.1:9/";
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    const c = check(await run(), "access:opencode");
    expect(c?.detail).toContain(
      "docker version (Cannot connect to the Docker daemon at unix:///var/run/docker.sock)",
    );
    // Bun 1.4.3 prints ECONNREFUSED where older Bun printed ConnectionRefused
    expect(c?.detail).toMatch(/outbound HTTPS \((ConnectionRefused|ECONNREFUSED)/);
    expect(c?.detail).not.toContain("Bun v");
  });

  it("counts a proxy's 407 or 403 as blocked HTTPS, not reachable", async () => {
    for (const status of [407, 403]) {
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("", { status }),
      });
      try {
        machine();
        process.env.CATHERD_PROBE_URL = `http://127.0.0.1:${proxy.port}/-/ping`;
        installPlugin(VERSION);
        patchProfile("default", {}, { host: "claude-code" });
        const c = check(await run(), "access:opencode");
        expect(c).toMatchObject({ state: "warn", word: "blocked" });
        expect(c?.detail).toContain(`outbound HTTPS (HTTP ${status}`);
      } finally {
        proxy.stop(true);
      }
    }
  });

  it("says a probe past its time limit timed out, and a shell that did not start did not start", async () => {
    const shell = {
      how: "a fake shell",
      close: () => {},
      run: async (_s: string, args: string[]) =>
        args.includes(locksDir())
          ? { ok: false, out: "", err: "sh -c x _ y timed out after 20000 ms" }
          : args.includes(realTmpdir())
            ? null
            : { ok: true, out: "", err: "" },
    };
    const r = await runProbes(shell, false);
    expect(r.find((p) => p.id === "lock")?.why).toBe("timed out after 20 s");
    expect(r.find((p) => p.id === "temp")?.why).toBe("the probe shell did not start");
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
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
    patchProfile("default", { jev: { use: "off" } }, { host: "claude-code" });
    expect(check(await run(), "jev")).toMatchObject({
      state: "skip",
      word: "off",
    });
  }, 30_000);

  it("validates linked profiles diagnostically and uses only selected profile for Jev", async () => {
    ready();
    createProfile("team", undefined, "claude-code");
    activate("team", tempRepo(), "claude-code");
    const file = join(dirname(configFile()), "profiles", "team.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(
      file,
      JSON.stringify({
        ...doc,
        roles: {
          ...doc.roles,
          worker: { ...doc.roles.worker, enabled: false },
        },
      }),
    );
    const r = await run();
    expect(check(r, "profile")).toMatchObject({
      state: "ok",
      label: "profile default",
    });
    expect(check(r, "profile:team")).toMatchObject({
      state: "warn",
      word: "invalid",
      label: "profile team",
      fix: "catherd profile set --profile team --host claude-code roles.worker.enabled true",
    });
    patchProfile("default", { jev: { use: "off" } }, { host: "claude-code" });
    expect(check(await run(), "jev")).toMatchObject({
      state: "skip",
      word: "off",
    });
    writeFileSync(file, JSON.stringify({ ...doc, jev: { use: "off" } }));
    expect(check(await run(), "jev")).toMatchObject({
      state: "skip",
      word: "off",
    });
    // three whole doctor runs, each probing every simulated CLI: a slow macOS runner outlasts the 5 s default
  }, 30_000);

  it("warns when ui-reviewer is on but agent-browser is not on PATH, naming each profile that turns it on", async () => {
    machine({ agentBrowser: false });
    installPlugin(VERSION);
    patchProfile("default", {}, { host: "claude-code" });
    createProfile("team", undefined, "claude-code");
    activate("team", tempRepo(), "claude-code");
    const r = await run();
    expect(r.ready).toBe(true);
    expect(check(r, "ui-browser")).toEqual({
      id: "ui-browser",
      label: "agent-browser",
      state: "warn",
      word: "missing",
      detail: "agent-browser is not on PATH, so ui-reviewer (default, team) cannot take screenshots",
      fix: [
        "npm i -g agent-browser",
        "or turn the role off:",
        "catherd profile set roles.ui-reviewer.enabled false --profile default --host claude-code",
        "catherd profile set roles.ui-reviewer.enabled false --profile team --host claude-code",
      ].join("\n"),
    });
  }, 30_000);

  it("says nothing about agent-browser when it is on PATH or no profile turns ui-reviewer on", async () => {
    ready();
    expect(check(await run(), "ui-browser")).toBeUndefined();
    machine({ agentBrowser: false });
    installPlugin(VERSION);
    patchProfile("default", { roles: { "ui-reviewer": { enabled: false } } }, { host: "claude-code" });
    expect(check(await run(), "ui-browser")).toBeUndefined();
  }, 30_000);

  it("warns about another repo bound to a missing profile", async () => {
    ready();
    createProfile("team", undefined, "claude-code");
    const repo = tempRepo();
    activate("team", repo, "claude-code");
    rmSync(join(dirname(configFile()), "profiles", "team.json"));
    expect(check(await run(), `binding:${repo}`)).toMatchObject({
      state: "warn",
      word: "missing",
      fix: `cd ${repo} && catherd profile use --repo --clear`,
    });
  });

  it("checks selected backends and warns when another linked profile is corrupt", async () => {
    ready();
    createProfile("team", undefined, "claude-code");
    activate("team", tempRepo(), "claude-code");
    writeFileSync(join(dirname(configFile()), "profiles", "team.json"), "{ not json");
    process.env.PATH = process.env.PATH?.replace(/^[^:]+/, (bin) => {
      const only = binDir();
      symlinkSync(join(bin, "claude"), join(only, "claude"));
      return only;
    });
    const r = await run();
    expect(check(r, "backend:codex")).toMatchObject({
      state: "fail",
      word: "missing",
    });
    expect(check(r, "profile:team")).toMatchObject({ state: "warn" });
  });

  it("tests the Codex sandbox only when Codex serves an enabled workspace-write role", async () => {
    ready();
    patchProfile(
      "default",
      {
        roles: {
          worker: { access: "read-only" },
          writer: { access: "read-only" },
          artist: { access: "read-only" },
        },
      },
      { host: "claude-code" },
    );
    const r = await run();
    expect(check(r, "backend:codex")?.state).toBe("ok");
    expect(check(r, "sandbox:codex")).toBeUndefined();
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

  it("warns on a credentials file it cannot read, which Jev takes for no key", async () => {
    ready();
    saveJevKey("tsk-test-key-0123456789");
    writeFileSync(credentialsPath(), "{ not json");
    const r = await run();
    expect(check(r, "credentials")).toMatchObject({
      state: "warn",
      word: "unreadable",
      fix: `delete ${credentialsPath()} and run catherd init, or write it as {"schema": 1, "typesafeApiKey": "<your key>"}`,
    });
    expect(check(r, "jev")).toMatchObject({ state: "warn", word: "no key" });
  });

  it("reads a corrupt index as one not fetched, and fails a profile with nothing indexed", async () => {
    ready();
    writeFileSync(indexPath(), "{ not json");
    const r = await run();
    expect(r.ready).toBe(false);
    expect(check(r, "catalog")).toMatchObject({
      state: "info",
      word: "not fetched",
      fix: "catherd catalog sync",
    });
    expect(check(r, "profile")).toMatchObject({
      state: "fail",
      word: "invalid",
      detail: expect.stringContaining("has no usable rung"),
    });
  });

  it("shows the catalog row: not fetched, fresh, failing with the last index kept, stale after a day", () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const status = (o: Partial<Parameters<typeof indexCheck>[1] & object> = {}) => ({
      fetchedAt: "2026-10-21T11:00:00.000Z",
      checkedAt: "2026-10-21T11:30:00.000Z",
      pairs: 81,
      error: null,
      ...o,
    });
    const none = { fetchedAt: null, checkedAt: null, pairs: 0, error: null };
    expect(indexCheck(now, none)).toMatchObject({
      state: "info",
      word: "not fetched",
      fix: "catherd catalog sync",
    });
    expect(indexCheck(now, status())).toEqual({
      id: "catalog",
      label: "catalog",
      state: "ok",
      word: "fresh",
      detail: "81 pairs, fetched 1 h ago",
    });
    expect(indexCheck(now, status({ error: "http 503" }))).toMatchObject({
      state: "warn",
      word: "failing",
      detail: "http 503; keeps the index fetched 1 h ago",
    });
    expect(
      indexCheck(now, { fetchedAt: null, checkedAt: "2026-10-21T11:30:00.000Z", pairs: 0, error: "offline" }),
    ).toMatchObject({ state: "warn", word: "failing", detail: "offline; no index" });
    expect(indexCheck(now, status({ checkedAt: "2026-10-20T11:00:00.000Z" }))).toMatchObject({
      state: "warn",
      word: "stale",
      fix: "catherd catalog sync --force",
    });
  });

  it("warns, not fails, on a profile rung that lost its index", async () => {
    ready();
    const recorded = readIndexFile(indexPath());
    if (!recorded) throw new Error("no recorded index");
    writeIndexFile(indexPath(), {
      ...recorded,
      models: recorded.models.filter((m) => !(m.family === "gpt-6-sol" && m.effort === "xhigh")),
    });
    const r = await run();
    expect(r.ready).toBe(true);
    expect(check(r, "profile")).toMatchObject({
      state: "warn",
      word: "warning",
      detail: expect.stringContaining("codex:gpt-6-sol#xhigh has no Slopalytics intelligence index"),
    });
  });

  // several doctor runs, each probing every simulated CLI: a loaded machine outlasts the 5 s default
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
      JSON.stringify({
        ...doc,
        roles: {
          ...doc.roles,
          worker: { ...doc.roles.worker, enabled: false },
        },
      }),
    );
    expect(check(await run(), "profile")).toMatchObject({
      state: "fail",
      word: "invalid",
    });
    writeFileSync(configFile(), JSON.stringify({ activeProfile: "default" }));
    expect(check(await run(), "config")).toMatchObject({
      state: "fail",
      fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
    });
  }, 30_000);
});

it("codex_ready_other_profile_broken keeps readiness selected and does no Claude writes", async () => {
  const models = fx("codex/models.json");
  models.models.push({ ...models.models[1], slug: "gpt-6.1-sol" });
  machine({ bins: ["codex"], codex: { models, queue: "accepted" } });
  const repo = tempRepo();
  expect(createProfile("team", undefined, "codex").saved).toBe(true);
  activate("team", repo, "codex");
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(join(profilesDir(), "broken.json"), "{bad json");
  const bindings = JSON.parse(readFileSync(projectsFile(), "utf8"));
  bindings.bindings["/other/repo"] = "broken";
  writeFileSync(projectsFile(), JSON.stringify(bindings));
  const r = await run({
    host: { host: "codex", session: null, conflict: null },
    repo,
  });
  expect(r.ready).toBe(true);
  expect(check(r, "profile:broken")?.state).toBe("warn");
  expect(check(r, "plugin")?.state).toBe("skip");
  expect(check(r, "backend:claude-code")?.state).toBe("skip");
  expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "agents"))).toBe(false);
  expect(existsSync(process.env.CATHERD_CLAUDE_AGENTS_DIR!)).toBe(false);
  const ctx = {
    host: { host: "codex" as const, session: null, conflict: null },
    repo,
  };
  expect(
    patchProfile(
      "team",
      {
        roles: {
          writer: { enabled: false, rungs: ["claude:claude-opus-5-5#high"] },
        },
        failover: { "codex:unused-model#high": "claude:claude-opus-5-5#low" },
      },
      { host: "codex" },
    ).saved,
  ).toBe(true);
  expect((await run(ctx)).ready).toBe(true);
  expect(
    patchProfile(
      "team",
      {
        failover: {
          "codex:gpt-6-luna#high": "claude-code:claude-opus-5-5#high",
        },
      },
      { host: "codex" },
    ).saved,
  ).toBe(true);
  const optional = await run(ctx);
  expect(optional.ready).toBe(true);
  expect(check(optional, "backend:claude-code")?.state).toBe("warn");
  expect(
    patchProfile(
      "team",
      { roles: { architect: { rungs: ["claude-code:claude-opus-5-5#high"] } } },
      { host: "codex" },
    ).saved,
  ).toBe(true);
  const required = await run(ctx);
  expect(required.ready).toBe(false);
  expect(check(required, "backend:claude-code")?.state).toBe("fail");
  expect(existsSync(process.env.CATHERD_CLAUDE_AGENTS_DIR!)).toBe(false);
}, 30_000);

it("native failover-only missing managed links warn while the Claude host still requires its plugin", async () => {
  machine({ bins: ["codex"] });
  installPlugin(VERSION);
  expect(
    patchProfile(
      "default",
      {
        roles: { architect: { enabled: false }, verifier: { enabled: false }, judge: { enabled: false } },
        failover: { "codex:gpt-6-luna#high": "claude:claude-opus-5-5#high" },
      },
      { host: "claude-code" },
    ).saved,
  ).toBe(true);
  rmSync(process.env.CATHERD_CLAUDE_AGENTS_DIR!, {
    recursive: true,
    force: true,
  });
  const r = await run();
  expect(check(r, "agents")?.state).toBe("warn");
  expect(r.ready).toBe(true);
  rmSync(join(process.env.CLAUDE_CONFIG_DIR!, "plugins"), {
    recursive: true,
    force: true,
  });
  expect(check(await run(), "plugin")?.state).toBe("fail");
});

it("default_doctor_sends_nothing even when a smoke callback is available", async () => {
  ready();
  let sent = 0;
  const push = async () => {
    sent++;
    return {
      outcome: "ok" as const,
      detail: "enqueue accepted",
      enqueue: "accepted" as const,
      processing: "unconfirmed" as const,
      msgId: "receipt",
    };
  };
  await run({ push });
  expect(sent).toBe(0);
  const explicit = await run({ testPush: true, push });
  expect(sent).toBe(1);
  expect(explicit.push).toMatchObject({
    enqueue: "accepted",
    processing: "unconfirmed",
  });
});

it("Codex-only doctor never invokes an unused Claude CLI that writes configuration, but selected headless roles still probe", async () => {
  const models = fx("codex/models.json");
  models.models.push({ ...models.models[1], slug: "gpt-6.1-sol" });
  machine({ bins: ["codex"], codex: { models } });
  const bin = tempDir("claude-doctor-sentinel-");
  const calls = join(process.env.CATHERD_HOME!, "claude-probe-calls");
  writeFileSync(
    join(bin, "claude"),
    '#!/bin/sh\nmkdir -p "$CLAUDE_CONFIG_DIR"\nprintf "%s\\n" "$*" >> "$CATHERD_HOME/claude-probe-calls"\nprintf x > "$CLAUDE_CONFIG_DIR/probe-sentinel"\nif [ "$1" = --version ]; then echo 2.1.0; else printf \'{"loggedIn":false}\\n\'; fi\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const ctx = {
    host: { host: "codex" as const, session: null, conflict: null },
  };
  const unused = await run(ctx);
  expect(check(unused, "backend:claude-code")).toMatchObject({
    state: "skip",
    word: "not required",
  });
  expect(existsSync(calls)).toBe(false);
  expect(existsSync(join(process.env.CLAUDE_CONFIG_DIR!, "probe-sentinel"))).toBe(false);
  expect(
    patchProfile(
      "default",
      { roles: { architect: { rungs: ["claude-code:claude-opus-5-5#high"] } } },
      { host: "codex" },
    ).saved,
  ).toBe(true);
  const selected = await run(ctx);
  expect(check(selected, "backend:claude-code")?.state).toBe("fail");
  expect(readFileSync(calls, "utf8")).toContain("auth status --json");
  rmSync(calls);
  expect(
    patchProfile(
      "default",
      {
        roles: { architect: { rungs: ["codex:gpt-6.1-sol#high"] } },
        failover: {
          "codex:gpt-6-luna#high": "claude-code:claude-opus-5-5#high",
        },
      },
      { host: "codex" },
    ).saved,
  ).toBe(true);
  expect(check(await run(ctx), "backend:claude-code")?.state).toBe("warn");
  expect(readFileSync(calls, "utf8")).toContain("auth status --json");
});

describe("accessRepos (Codex P2: only the checked profiles' repos)", () => {
  it("keeps the current repo and the repos bound to a checked profile, and drops the others", () => {
    const bindings = { "/a": "default", "/b": "other", "/c": "default" };
    expect(accessRepos("/here", bindings, ["default"])).toEqual(["/here", "/a", "/c"]);
    expect(accessRepos(null, bindings, ["other"])).toEqual(["/b"]);
    expect(accessRepos("/a", bindings, [])).toEqual(["/a"]);
  });
});

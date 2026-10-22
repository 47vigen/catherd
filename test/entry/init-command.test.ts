import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { dirname, join } from "node:path";
import {
  globalStep,
  jevStep,
  NEXT_PLUGIN_STEPS,
  PLUGIN_STEPS,
  pluginSteps,
  profileLines,
  syncStep,
  welcomeLines,
} from "../../src/entry/init-command.ts";
import type { Prompter } from "../../src/entry/prompt.ts";
import { VERSION } from "../../src/infra/version.ts";
import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
import type { IndexStatus } from "../../src/services/catalog-service.ts";
import { activate, patchProfile } from "../../src/services/profile-service.ts";
import { BUILTIN_ROLES } from "../../src/domain/profile.ts";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { activeName, getProfile } from "../../src/services/profile-store.ts";
import { bunOnlyBin, noPosixModes, openModes, snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

/** The spawned init's BUN_INSTALL: never the user's own global folder (1.1 follow-ups). */
const INIT_BUN_INSTALL = tempDir("catherd-bun-install-");

function init(args: string[], stdin = "", cwd?: string) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "init", ...args], {
    // no backend CLI, no Jev key and no Anthropic key: nothing reaches the network or the user's own CLIs
    env: {
      ...process.env,
      CATHERD_ORCHESTRATION_HOST: args.includes("--host") ? "" : "claude-code",
      // test/bin: the MCP launcher's "global catherd" is this checkout, so doctor's handshake never runs bunx
      PATH: `/nonexistent:${join(import.meta.dir, "..", "bin")}:${bunOnlyBin()}:/usr/bin:/bin`,
      // bun's global bin is test/bin too, so init finds "this version installed globally" and never runs bun add -g
      BUN_INSTALL_BIN: join(import.meta.dir, "..", "bin"),
      // and should that ever miss, bun add -g lands in a scratch folder and its registry refuses at once
      BUN_INSTALL: INIT_BUN_INSTALL,
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
      TYPESAFE_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    stdin: new TextEncoder().encode(stdin),
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("pluginSteps", () => {
  it("prints nothing for a ready plugin, the stable marketplace for a release, the next one for a pre-release", () => {
    expect(pluginSteps(true, "2.0.0")).toEqual([]);
    expect(pluginSteps(true, "2.0.0-next.20261022113309")).toEqual([]);
    expect(pluginSteps(false, "2.0.0")).toEqual(PLUGIN_STEPS);
    expect(pluginSteps(false, "2.0.0-next.20261022113309")).toEqual(NEXT_PLUGIN_STEPS);
    expect(NEXT_PLUGIN_STEPS).toContain(
      "  claude plugin marketplace add https://github.com/47vigen/catherd.git#plugin-next",
    );
    expect(NEXT_PLUGIN_STEPS).toContain("  claude plugin install catherd@catherd-next");
  });
});

describe("globalStep (spec 1.1 §12)", () => {
  const lines = async (f: () => Promise<void>) => {
    const out: string[] = [];
    const log = console.log;
    console.log = (l: string) => out.push(l);
    try {
      await f();
    } finally {
      console.log = log;
    }
    return out;
  };
  /** `after`: what the catherd on PATH reports once the install ran (default: the installed version) */
  const deps = (onPath: string | null, ok = true, after?: string | null) => {
    let now = onPath;
    return {
      globalVersion: async () => now,
      pathVersion: async () => now,
      install: async (v: string) => {
        if (ok) now = after === undefined ? v : after;
        return { ok, output: ok ? "" : "error: 503 from the registry\n" };
      },
    };
  };

  it("says installing catherd… first, then that it is installed", async () => {
    expect(await lines(() => globalStep("1.1.0", { skip: false, deps: deps("1.0.0") }))).toEqual([
      "installing catherd… (bun add -g catherd-cli@1.1.0)",
      "✓ catherd 1.1.0 installed globally; the plugin starts it without bunx",
    ]);
  });

  it("says nothing about installing when this version is already global", async () => {
    expect(await lines(() => globalStep("1.1.0", { skip: false, deps: deps("1.1.0") }))).toEqual([
      "✓ catherd 1.1.0 is installed globally",
    ]);
  });

  it("goes on after a failed install, with the command to retry", async () => {
    expect(
      await lines(() => globalStep("1.1.0", { skip: false, deps: deps(null, false), plain: true })),
    ).toEqual([
      "installing catherd… (bun add -g catherd-cli@1.1.0)",
      "! could not install catherd globally: error: 503 from the registry",
      "    fix: bun add -g catherd-cli@1.1.0",
    ]);
  });

  it("says what to fix when the catherd first on PATH is still another one after the install", async () => {
    expect(
      await lines(() =>
        globalStep("1.1.0", { skip: false, deps: deps("1.0.0", true, "1.0.0"), plain: true }),
      ),
    ).toEqual([
      "installing catherd… (bun add -g catherd-cli@1.1.0)",
      "! catherd 1.1.0 installed globally, but the catherd first on PATH is 1.0.0, so the plugin starts it with bunx",
      "    fix: put bun's global bin folder (bun pm bin -g) first on PATH, then run catherd init again",
    ]);
    expect(
      await lines(() => globalStep("1.1.0", { skip: false, deps: deps(null, true, null), plain: true })),
    ).toEqual([
      "installing catherd… (bun add -g catherd-cli@1.1.0)",
      "! catherd 1.1.0 installed globally, but no catherd is on PATH, so the plugin starts it with bunx",
      "    fix: put bun's global bin folder (bun pm bin -g) first on PATH, then run catherd init again",
    ]);
  });

  it("goes on when the install itself throws", async () => {
    const d = {
      ...deps(null),
      install: async () => {
        throw new Error("spawn bun ENOENT");
      },
    };
    expect(await lines(() => globalStep("1.1.0", { skip: false, deps: d, plain: true }))).toEqual([
      "installing catherd… (bun add -g catherd-cli@1.1.0)",
      "! could not install catherd globally: spawn bun ENOENT",
      "    fix: bun add -g catherd-cli@1.1.0",
    ]);
  });

  it("skips the install with --no-global", async () => {
    let asked = false;
    const d = { ...deps(null), globalVersion: async () => ((asked = true), null) };
    expect(await lines(() => globalStep("1.1.0", { skip: true, deps: d }))).toEqual([
      "- catherd: not installed globally (--no-global); the plugin starts it with bunx",
    ]);
    expect(asked).toBe(false);
  });
});

describe("catherd init", () => {
  it("Codex --no-input uses the effective repo profile and leaves the native global default unlinked", () => {
    withHome();
    const repo = tempRepo();
    patchProfile("default", { roles: structuredClone(BUILTIN_ROLES) }, { host: "claude-code" });
    // Remove existing links to expose any unwanted setup linking of the global profile.
    rmSync(claudeAgentsDir(), { recursive: true, force: true });
    patchProfile("repo-codex", { budget: { usd: 9 } }, { host: "codex" });
    activate("repo-codex", repo, "codex");
    const r = init(["--host", "codex", "--no-input", "--no-global"], "", repo);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("profile repo-codex kept as it was, and active");
    expect(activeName()).toBe("default");
    expect(activeName(repo)).toBe("repo-codex");
    expect(existsSync(claudeAgentsDir())).toBe(false);
    expect(getProfile("repo-codex", "codex").budget).toEqual({ usd: 9 });
  }, 60_000);

  it("--no-input writes and activates the default profile, reports readiness, and ends with the plugin steps", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const r = init(["--no-input"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("(=^.^=)");
    // test/bin/catherd prints this version: the global install is already there
    expect(r.out).toContain(`✓ catherd ${VERSION} is installed globally\n`);
    // the shim is the only guard between the suite and the registry: no `bun add -g` ran (Ruling R8)
    expect(r.out).not.toContain("installing catherd…");
    expect(r.out).not.toContain("bun add -g");
    expect(r.out).toContain("✓ profile default written from the defaults, and active\n");
    expect(r.out).toMatch(/✓ ready {14}MCP server — answers tools\/list with \d+ tools\n/);
    expect(r.out).toContain("✗ missing            Claude Code plugin — not installed in Claude Code\n");
    expect(r.out.trimEnd().split("\n").slice(-4)).toEqual(PLUGIN_STEPS);
    expect(activeName()).toBe("default");
    if (!noPosixModes)
      expect([...openModes(join(home, "config")), ...openModes(join(home, "data"))]).toEqual([]);
    // a second run on the same home: it keeps the profile it finds, and --plain draws ASCII as doctor does
    patchProfile("default", { budget: { usd: 9 } }, { host: "claude-code" });
    const again = init(["--no-input", "--no-global", "--plain"]);
    expect(again.out).toContain(
      "- catherd: not installed globally (--no-global); the plugin starts it with bunx\n",
    );
    expect(again.out).toContain("+ profile default kept as it was, and active\n");
    expect(again.out).toContain("x missing            Claude Code plugin — not installed in Claude Code\n");
    expect(again.out).not.toMatch(/[✓✗]/);
    expect(getProfile("default", "claude-code").budget).toEqual({ usd: 9 });
  }, 60_000);

  it("--no-input prints no plugin steps when its own report shows the plugin ready, from any marketplace", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const plugins = join(home, "claude", "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "catherd@catherd-next": [{ version: VERSION }] } }),
    );
    const r = init(["--no-input"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`✓ ready              Claude Code plugin — ${VERSION}\n`);
    expect(r.out).not.toContain("Install the Claude Code plugin");
    expect(r.out).not.toContain("marketplace add");
  }, 60_000);

  it("reads piped answers: an empty key skips Jev, a name picks the profile, y replaces it", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    patchProfile("team", { budget: { usd: 9 } }, { host: "claude-code" });
    const r = init([], "\nteam\ny\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("TypeSafe API key for Jev (optional; Enter skips): \n- Jev: no key;");
    expect(r.out).not.toContain("Artificial Analysis");
    // the suite sets CATHERD_NO_SYNC=1 (test/preload.ts): init says so instead of reaching the network
    expect(r.out).toContain("- catalog: not fetched (CATHERD_NO_SYNC=1); catherd catalog sync fetches it\n");
    expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
    expect([activeName(), getProfile("team", "claude-code").budget]).toEqual(["team", {}]);
  }, 60_000);

  it("refuses a bad profile name as a usage error", () => {
    withHome();
    const r = init(["--no-input", "--profile", "Team"]);
    expect([r.code, r.err.split("\n")[0]]).toEqual([2, 'error E_INPUT_INVALID: bad profile name "Team"']);
  });

  it("refuses a bad --profile before asking anything", () => {
    withHome();
    const r = init(["--profile", "Team"], "\n");
    expect([r.code, r.out]).toEqual([2, ""]);
  });

  it("moves a 0.x profile aside before asking whether to replace it", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    mkdirSync(join(dirname(credentialsPath()), "profiles"), { recursive: true });
    writeFileSync(
      join(dirname(credentialsPath()), "profiles", "team.json"),
      JSON.stringify({ name: "team" }),
    );
    const r = init([], "\nteam\n");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Replace profile");
    expect(r.out).toContain("profiles/team.json\n✓ profile team written from the defaults, and active\n");
  }, 60_000);

  it("finishes when the defaults do not validate here: says why, writes nothing, still reports", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    writeDiscovery("codex", [{ id: "gpt-6-sol", efforts: ["low"], context: null, imageIn: true }]);
    const r = init(["--no-input"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "! profile default: the default profile does not validate here, so it was not written\n",
    );
    expect(r.out).toContain('! roles.reviewer.rungs: gpt-6-sol has no effort "high" on codex (it has low)\n');
    expect(r.out).toContain(
      "! no profile was made active: fix the rows above, then run catherd init again\n",
    );
    expect(r.out).not.toContain("written from the defaults");
    expect(r.out.trimEnd().split("\n").slice(-4)).toEqual(PLUGIN_STEPS);
    expect(existsSync(join(dirname(credentialsPath()), "profiles", "default.json"))).toBe(false);
  }, 60_000);

  it("goes on when an unparsable credentials.json refuses the key, saying why and how to fix it", async () => {
    withHome();
    process.env.TYPESAFE_API_KEY = "";
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{not json");
    const ask: Prompter = { ask: async () => "", secret: async () => "ts-key", close() {} };
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      // a key that answers, without the network
      await jevStep(ask, { testJevKey: async () => true });
    } finally {
      log.mockRestore();
    }
    expect(lines[0]).toStartWith(`! Jev: could not save the key: ${credentialsPath()} is not valid JSON`);
    expect(lines[1]).toBe(
      `    fix: delete ${credentialsPath()} and run catherd init, or write it as {"schema": 1, "typesafeApiKey": "<your key>"}`,
    );
  });

  it("profileLines draws init's own profile rows, ASCII under plain", () => {
    const r = {
      moved: [],
      profile: "team",
      created: true,
      errors: [],
      active: true,
      synced: null,
      refreshed: [],
    };
    expect(profileLines(r)).toEqual(["✓ profile team written from the defaults, and active"]);
    expect(profileLines({ ...r, created: false }, true)).toEqual([
      "+ profile team kept as it was, and active",
    ]);
    const bad = {
      ...r,
      active: false,
      errors: [{ path: "roles.x", message: "no such rung", fix: "edit it" }],
    };
    expect(profileLines(bad, true)).toEqual([
      "! profile team: the default profile does not validate here, so it was not written",
      "! roles.x: no such rung",
      "    fix: edit it",
      "! no profile was made active: fix the rows above, then run catherd init again",
    ]);
  });

  it("a saved Jev key skips the key question, keeping piped answers in place, and tests nothing", async () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    saveJevKey("ts-live-0123456789abcdef");
    let skipped = 0;
    const ask: Prompter = {
      ask: async () => "",
      secret: async () => {
        throw new Error("asked for the key");
      },
      skip: () => void skipped++,
      close() {},
    };
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await jevStep(ask, {
        testJevKey: async () => {
          throw new Error("reached the network");
        },
      });
    } finally {
      log.mockRestore();
    }
    expect(skipped).toBe(1);
    expect(lines).toEqual(["✓ Jev: using the saved key"]);
  });

  it("greets a terminal with the mascot (spec §9.3)", () => {
    expect(welcomeLines("1.0.0")).toEqual([
      " /\\_/\\  .",
      "(=^.^=)/   catherd 1.0.0",
      ' (")(")    herds your coding agents',
      "",
    ]);
  });
});

/** What a step printed, line by line. */
async function printed(f: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  try {
    await f();
  } finally {
    log.mockRestore();
  }
  return lines;
}

describe("syncStep", () => {
  const status: IndexStatus = {
    fetchedAt: "2026-10-21T10:00:00.000Z",
    checkedAt: "2026-10-21T10:00:00.000Z",
    pairs: 81,
    error: null,
  };

  it("fetches the index in the foreground and says how many pairs it holds", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    expect(await printed(() => syncStep({ sync: async () => status }))).toEqual([
      "fetching the Slopalytics index…",
      "✓ Slopalytics: 81 pairs indexed",
    ]);
  });

  it("never stops init: a failed fetch is a ! line with its fix", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    expect(
      await printed(() => syncStep({ sync: async () => ({ ...status, pairs: 0, error: "http 503" }) })),
    ).toEqual([
      "fetching the Slopalytics index…",
      "! Slopalytics: http 503",
      "    fix: catherd catalog sync",
    ]);
    const thrown = await printed(() =>
      syncStep({
        sync: async () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(thrown).toEqual([
      "fetching the Slopalytics index…",
      "! Slopalytics: disk full",
      "    fix: catherd catalog sync",
    ]);
  });

  it("is skipped with CATHERD_NO_SYNC=1", async () => {
    withHome();
    process.env.CATHERD_NO_SYNC = "1";
    let ran = false;
    const lines = await printed(() =>
      syncStep({
        sync: async () => {
          ran = true;
          return status;
        },
      }),
    );
    expect([ran, lines]).toEqual([
      false,
      ["- catalog: not fetched (CATHERD_NO_SYNC=1); catherd catalog sync fetches it"],
    ]);
  });
});

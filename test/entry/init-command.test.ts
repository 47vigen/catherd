import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { dirname, join } from "node:path";
import {
  aaStep,
  globalStep,
  jevStep,
  PLUGIN_STEPS,
  syncStep,
  welcomeLines,
} from "../../src/entry/init-command.ts";
import type { Prompter } from "../../src/entry/prompt.ts";
import { VERSION } from "../../src/infra/version.ts";
import { aaKey, saveAaKey } from "../../src/services/credentials.ts";
import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
import type { SyncReport } from "../../src/services/source-sync.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { activeName, getProfile } from "../../src/services/profile-store.ts";
import { noPosixModes, openModes, snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function init(args: string[], stdin = "") {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "init", ...args], {
    // no backend CLI, no Jev key and no Anthropic key: nothing reaches the network or the user's own CLIs
    env: {
      ...process.env,
      // test/bin: the MCP launcher's "global catherd" is this checkout, so doctor's handshake never runs bunx
      PATH: `/nonexistent:${join(import.meta.dir, "..", "bin")}:${join(process.execPath, "..")}:/usr/bin:/bin`,
      // bun's global bin is test/bin too, so init finds "this version installed globally" and never runs bun add -g
      BUN_INSTALL_BIN: join(import.meta.dir, "..", "bin"),
      TYPESAFE_API_KEY: "",
      ARTIFICIAL_ANALYSIS_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

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
    expect(init(["--no-input", "--no-global"]).out).toContain(
      "- catherd: not installed globally (--no-global); the plugin starts it with bunx\n",
    );
    expect(r.out).toContain("✓ profile default written from the defaults, and active\n");
    expect(r.out).toMatch(/✓ ready {14}MCP server — answers tools\/list with \d+ tools\n/);
    expect(r.out).toContain("✗ missing            Claude Code plugin — not installed in Claude Code\n");
    expect(r.out.trimEnd().split("\n").slice(-4)).toEqual(PLUGIN_STEPS);
    expect(activeName()).toBe("default");
  }, 60_000);

  it("--plain prints ASCII glyphs as doctor --plain does, and NO_COLOR keeps doctor's own (audit N2)", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const plain = init(["--no-input", "--plain"]).out;
    expect(plain).toContain("+ profile default written from the defaults, and active\n");
    expect(plain).toContain("x missing            Claude Code plugin — not installed in Claude Code\n");
    expect(plain).not.toMatch(/[✓✗]/);
    process.env.NO_COLOR = "1";
    const noColor = init(["--no-input"]).out;
    expect(noColor).toContain("✓ profile default kept as it was, and active\n");
    expect(noColor).toContain("✗ missing            Claude Code plugin");
  }, 60_000);

  it("--no-input never prints a bare key pasted into credentials.json (B1)", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const key = "tsk_FAKEKEY_DO_NOT_USE_1234567890";
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), `${key}\n`, { mode: 0o600 });
    const r = init(["--no-input"]);
    expect(r.code).toBe(0);
    const pieces = Array.from({ length: key.length - 5 }, (_, i) => key.slice(i, i + 6));
    expect(pieces.filter((p) => (r.out + r.err).includes(p))).toEqual([]);
    expect(r.out).toContain(`${credentialsPath()} is not valid JSON`);
  }, 60_000);

  it.skipIf(noPosixModes)(
    "--no-input keeps every config and data dir at 0700 and file at 0600 (audit S2)",
    () => {
      const home = withHome();
      process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
      expect(init(["--no-input"]).code).toBe(0);
      expect(existsSync(join(home, "config", "config.json"))).toBe(true);
      expect([...openModes(join(home, "config")), ...openModes(join(home, "data"))]).toEqual([]);
    },
    60_000,
  );

  it("--no-input keeps a profile it finds", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    patchProfile("default", { budget: { usd: 9 } });
    expect(init(["--no-input"]).out).toContain("✓ profile default kept as it was, and active\n");
    expect(getProfile("default").budget).toEqual({ usd: 9 });
  }, 60_000);

  it("reads piped answers: empty keys skip Jev and Artificial Analysis, a name picks the profile, y replaces it", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    patchProfile("team", { budget: { usd: 9 } });
    const r = init([], "\n\nteam\ny\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("TypeSafe API key for Jev (optional; Enter skips): \n- Jev: no key;");
    expect(r.out).toContain(
      "Artificial Analysis API key (optional; Enter skips): \n- Artificial Analysis: no key; scores come from the keyless sources",
    );
    // the suite sets CATHERD_NO_SYNC=1 (test/preload.ts): init says so instead of reaching the network
    expect(r.out).toContain("- sources: not synced (CATHERD_NO_SYNC=1); catherd catalog sync fetches them\n");
    expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
    expect([activeName(), getProfile("team").budget]).toEqual(["team", {}]);
  }, 60_000);

  it("keeps piped answers in place when a saved key skips the key question", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    saveJevKey("ts-live-0123456789abcdef");
    const r = init([], "ts-live-0123456789abcdef\n\nteam\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
    expect(`${r.out}${r.err}`).not.toContain("0123456789abcdef");
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
    const r = init([], "\n\nteam\n");
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
const typed = (key: string): Prompter => ({ ask: async () => "", secret: async () => key, close() {} });

describe("aaStep (spec 1.2 §9)", () => {
  it("takes ARTIFICIAL_ANALYSIS_API_KEY first, then the saved key, asking nothing", async () => {
    withHome();
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-env-0123456789";
    let skipped = 0;
    const ask: Prompter = { ...typed("x"), skip: () => void skipped++ };
    expect(await printed(() => aaStep(ask))).toEqual([
      "✓ Artificial Analysis: using ARTIFICIAL_ANALYSIS_API_KEY",
    ]);
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    saveAaKey("aa-saved-0123456789");
    expect(await printed(() => aaStep(ask))).toEqual(["✓ Artificial Analysis: using the saved key"]);
    expect(skipped).toBe(2);
  });

  it("skips on Enter, saves a key that answers, and keeps a refused or unchecked one out", async () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    expect(await printed(() => aaStep(typed("")))).toEqual([
      "- Artificial Analysis: no key; scores come from the keyless sources (add one later with catherd init)",
    ]);
    const refused = await printed(() =>
      aaStep(typed("aa-bad-0123456789"), { testAaKey: async () => ({ result: "refused" }) }),
    );
    expect(refused).toEqual(["! Artificial Analysis: the key was refused (401), so it was not saved"]);
    const offline = await printed(() =>
      aaStep(typed("aa-key-0123456789"), {
        testAaKey: async () => ({ result: "unchecked", error: "network error" }),
      }),
    );
    expect(offline).toEqual([
      "! Artificial Analysis: the key could not be checked (network error), so it was not saved; run catherd init again to retry",
    ]);
    expect(existsSync(credentialsPath())).toBe(false);
    const ok = await printed(() =>
      aaStep(typed("aa-good-0123456789"), { testAaKey: async () => ({ result: "ok" }) }),
    );
    expect(ok).toEqual(["✓ Artificial Analysis: the key answers; saved with mode 600"]);
    expect(aaKey()).toBe("aa-good-0123456789");
  });

  it("goes on when credentials.json refuses the key, saying why and how to fix it", async () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{not json");
    const lines = await printed(() =>
      aaStep(typed("aa-key-0123456789"), { testAaKey: async () => ({ result: "ok" }) }),
    );
    expect(lines[0]).toStartWith(
      `! Artificial Analysis: could not save the key: ${credentialsPath()} is not valid JSON`,
    );
    expect(lines[1]).toStartWith(`    fix: delete ${credentialsPath()} and run catherd init`);
  });
});

describe("syncStep (spec 1.2 §9)", () => {
  const report: SyncReport = {
    busy: false,
    sources: [{ source: "arena", state: "fetched", fetchedAt: "2026-09-28T10:00:00.000Z" }],
    newlyScored: [],
    noLongerNeeded: [],
    failed: [],
    warnings: [],
    unmatched: {},
  };

  it("syncs in the foreground and prints what catalog sync prints", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    expect(await printed(() => syncStep({ sync: async () => report }))).toEqual([
      "syncing the public model sources…",
      "✓ arena: fetched",
    ]);
  });

  it("never stops init: a sync that throws is a ! line with its fix", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    const lines = await printed(() =>
      syncStep({
        sync: async () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(lines).toEqual([
      "syncing the public model sources…",
      "! sources: disk full",
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
          return report;
        },
      }),
    );
    expect([ran, lines]).toEqual([
      false,
      ["- sources: not synced (CATHERD_NO_SYNC=1); catherd catalog sync fetches them"],
    ]);
  });
});

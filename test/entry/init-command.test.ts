import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { dirname, join } from "node:path";
import { jevStep, PLUGIN_STEPS, welcomeLines } from "../../src/entry/init-command.ts";
import type { Prompter } from "../../src/entry/prompt.ts";
import { credentialsPath } from "../../src/services/jev-service.ts";
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
      PATH: `/nonexistent:${join(process.execPath, "..")}:/usr/bin:/bin`,
      TYPESAFE_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("catherd init", () => {
  it("--no-input writes and activates the default profile, reports readiness, and ends with the plugin steps", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const r = init(["--no-input"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("(=^.^=)");
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

  it("reads piped answers: an empty key skips Jev, a name picks the profile, y replaces it", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    patchProfile("team", { budget: { usd: 9 } });
    const r = init([], "\nteam\ny\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("TypeSafe API key for Jev (optional; Enter skips): \n- Jev: no key;");
    expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
    expect([activeName(), getProfile("team").budget]).toEqual(["team", {}]);
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

  it("greets a terminal with the mascot (spec §9.3)", () => {
    expect(welcomeLines("1.0.0")).toEqual([
      " /\\_/\\  .",
      "(=^.^=)/   catherd 1.0.0",
      ' (")(")    herds your coding agents',
      "",
    ]);
  });
});

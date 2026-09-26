import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jevStep, PLUGIN_STEPS } from "../../src/entry/init-command.ts";
import type { Prompter } from "../../src/entry/prompt.ts";
import { credentialsPath } from "../../src/services/jev-service.ts";
import { activeName, getProfile, patchProfile } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
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
    expect(r.out).toContain("✓ profile default written from the defaults, and active\n");
    expect(r.out).toMatch(/✓ ready {14}MCP server — answers tools\/list with \d+ tools\n/);
    expect(r.out).toContain("✗ missing            Claude Code plugin — not installed in Claude Code\n");
    expect(r.out.trimEnd().split("\n").slice(-4)).toEqual(PLUGIN_STEPS);
    expect(activeName()).toBe("default");
  }, 60_000);

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
    expect(lines[0]).toStartWith(`! Jev: could not save the key: ${credentialsPath()} is not readable JSON`);
    expect(lines[1]).toBe(`    fix: fix or delete ${credentialsPath()}`);
  });
});

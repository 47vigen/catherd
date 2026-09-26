import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keybindsFromConfig, openTui } from "../../../src/entry/tui/run.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { SRC } from "../../import-graph.ts";

afterEach(snapshotEnv());

/** An explicit env for a spawned catherd: this test's home, and no key for discovery to spend. */
const envFor = (home: string) => ({ ...process.env, CATHERD_HOME: home, ANTHROPIC_API_KEY: "" });

describe("openTui", () => {
  it("refuses a terminal that is not interactive, with exit 2 and what to run instead", async () => {
    withHome();
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await openTui({ rawArgs: [], tty: false })).toBe(2);
      expect(String(err.mock.calls[0]?.[0])).toContain("catherd watch --once");
    } finally {
      err.mockRestore();
    }
  });

  it("reads keybinds from config.json and refuses a bad one before drawing anything", () => {
    const home = withHome();
    mkdirSync(join(home, "config"), { recursive: true });
    const write = (keybinds: unknown) =>
      writeFileSync(join(home, "config", "config.json"), JSON.stringify({ schema: 1, keybinds }));
    write({ "profile.save": "ctrl+w" });
    expect(keybindsFromConfig()["profile.save"]).toEqual(["ctrl+w"]);
    write({ "profile.saev": "ctrl+w" });
    expect(() => keybindsFromConfig()).toThrow(expect.objectContaining({ code: "E_CONFIG_KEYBIND" }));
  });

  it("loads OpenTUI for a bare catherd only, never behind a subcommand (spec §3.1)", () => {
    const home = withHome();
    const code = [
      `const { runCli } = await import(${JSON.stringify(join(SRC, "cli.ts"))});`,
      `await runCli(["status", "--json"]);`,
      `console.log("opentui modules:", Object.keys(require.cache).filter((k) => k.includes("@opentui")).length);`,
    ].join("\n");
    const p = Bun.spawnSync([process.execPath, "-e", code], {
      env: envFor(home),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.stdout.toString()).toContain("opentui modules: 0");
  });

  it("lists --plain and --reduced-motion in catherd --help and catherd watch --help", () => {
    const home = withHome();
    for (const args of [["--help"], ["watch", "--help"]]) {
      const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
        env: envFor(home),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(p.stdout.toString()).toContain("--plain");
      expect(p.stdout.toString()).toContain("--reduced-motion");
    }
  });
});

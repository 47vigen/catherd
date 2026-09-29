import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { withGrokScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "grok");
const SESSION = "3c9a2f1e-7b4d-4e8a-9f60-1d2c3b4a5e6f";

function grok(args: string[], env: Record<string, string>) {
  const p = Bun.spawnSync(["grok", ...args], {
    env: { PATH: simPath(), ANTHROPIC_API_KEY: "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

function brief(text: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "catherd-brief-")), "brief.md");
  writeFileSync(f, text);
  return f;
}

const NOT_SIGNED_IN =
  '{"type":"error","message":"Not signed in. To authenticate without a browser, run:\\n  grok login --device-code\\n"}\n';

describe("grok simulator (research §3)", () => {
  it("answers --version, and models with the auth line first, exit 0 even logged out", () => {
    const s = withGrokScenario({ models: ["grok-4.7", "grok-4.6"] });
    expect(grok(["--version"], s.env).out).toBe("grok 1.0.44 (5b807183dd79)\n");
    expect(grok(["models"], s.env).out).toBe(
      "You are logged in with Grok (owner@example.com).\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n",
    );
    const out = withGrokScenario({ loggedIn: false });
    expect(grok(["models"], out.env)).toMatchObject({
      code: 0,
      out: expect.stringMatching(/^You are not authenticated\.\n/),
    });
    expect(grok(["models"], { ...out.env, XAI_API_KEY: "k" }).out).toStartWith(
      "You are using XAI_API_KEY.\n",
    );
  });

  it("replays the events under its session id in --cwd, reading the brief from --prompt-file only", () => {
    const repo = tempDir("catherd-simrepo-");
    const s = withGrokScenario({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    const r = grok(
      [
        "--prompt-file",
        brief("---\nBRIEF"),
        "--output-format",
        "streaming-json",
        "--cwd",
        repo,
        "-s",
        SESSION,
      ],
      // an isolated run: catherd's GROK_HOME holds no login, the API key logs it in
      { ...s.env, HOME: "/iso/home", GROK_HOME: "/iso/home/.grok", XAI_API_KEY: "k" },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(`"sessionId":"${SESSION}"`);
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({
      stdin: "---\nBRIEF",
      home: "/iso/home",
      vars: { GROK_HOME: "/iso/home/.grok" },
    });
  });

  it("keeps a Grok login in GROK_HOME: one without auth.json is logged out, whatever the scenario", () => {
    const s = withGrokScenario({});
    const home = tempDir("catherd-grokhome-");
    expect(grok(["models"], { ...s.env, GROK_HOME: home }).out).toStartWith("You are not authenticated.\n");
    writeFileSync(join(home, "auth.json"), "{}");
    expect(grok(["models"], { ...s.env, GROK_HOME: home }).out).toStartWith("You are logged in with");
  });

  it("refuses read-only on a Mac with a symlinked docker socket before it checks the login", () => {
    const s = withGrokScenario({ socketSymlink: true, loggedIn: false });
    const ro = grok(["--prompt-file", brief("b"), "--sandbox", "read-only", "-s", SESSION], s.env);
    expect([ro.code, ro.out]).toEqual([1, ""]);
    expect(ro.err).toContain("error: could not apply the 'read-only' sandbox profile");
    expect(grok(["--prompt-file", brief("b"), "--sandbox", "workspace", "-s", SESSION], s.env)).toMatchObject(
      {
        code: 1,
        out: NOT_SIGNED_IN,
      },
    );
  });

  it("refuses an unknown flag with clap's exit 2, and another sandbox on resume", () => {
    const s = withGrokScenario({ unknownFlags: ["--no-memory"], sessionSandbox: "catherd-ws" });
    expect(grok(["--prompt-file", brief("b"), "--no-memory"], s.env)).toEqual({
      code: 2,
      out: "",
      err: "error: unexpected argument '--no-memory' found\n\nUsage: grok [OPTIONS]\n",
    });
    const resumed = grok(["--prompt-file", brief("b"), "-r", SESSION, "--sandbox", "off"], s.env);
    expect(resumed.code).toBe(1);
    expect(resumed.out).toContain("differs from the session's");
    expect(grok(["--prompt-file", brief("b"), "-r", SESSION], s.env).code).toBe(0);
  });
});

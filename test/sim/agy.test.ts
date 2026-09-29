import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { withAgyScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const CONV = "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b";

function agy(args: string[], env: Record<string, string>, cwd?: string) {
  const p = Bun.spawnSync(["agy", ...args], {
    env: { PATH: simPath(), ANTHROPIC_API_KEY: "", HOME: tempDir("catherd-agyhome-"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

/** A HOME whose agy settings name the Gemini API as the provider (research §4.8). */
function keyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "catherd-agykey-"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), '{"modelProvider":"gemini"}');
  return home;
}

const SIGN_IN =
  "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";

describe("agy simulator (research §4)", () => {
  it("answers --version and models, and fails models fast when logged out unless the key and provider are set", () => {
    const s = withAgyScenario({ modelsFile: join(FX, "models.txt") });
    expect(agy(["--version"], s.env).out).toBe("1.2.13\n");
    expect(agy(["models"], s.env).out).toContain("gemini-3.8-flash-high");
    expect(agy(["models", "--output-format", "json"], s.env).code).toBe(2);
    const out = withAgyScenario({ loggedIn: false, modelsFile: join(FX, "models.txt") });
    expect(agy(["models"], out.env)).toEqual({
      code: 1,
      out: "Fetching available models...\n",
      err: SIGN_IN,
    });
    // the key alone does nothing (research §4.8); with modelProvider "gemini" it signs in
    expect(agy(["models"], { ...out.env, GEMINI_API_KEY: "k" }).code).toBe(1);
    expect(agy(["models"], { ...out.env, GEMINI_API_KEY: "k", HOME: keyHome() }).code).toBe(0);
  });

  it("replays the events under the resumed conversation in its cwd, and records the prompt, HOME and settings", () => {
    const repo = tempDir("catherd-simrepo-");
    const home = keyHome();
    const s = withAgyScenario({
      eventsFile: join(FX, "resume.jsonl"),
      touch: [{ path: "a.ts", content: "x" }],
    });
    const r = agy(["-p", "Read the brief", "--output-format", "stream-json"], { ...s.env, HOME: home }, repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"conversation_id":"00000000-0000-4000-8000-0000000a9e1d"');
    expect(r.out).toContain(`"cwd":"${repo}"`);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({
      stdin: "Read the brief",
      home,
      settings: { modelProvider: "gemini" },
    });
    const again = agy(["--prompt=b", "-output-format", "stream-json", "--conversation", CONV], s.env, repo);
    expect(again.out).toContain(`"conversation_id":"${CONV}"`);
  });

  it("opens the browser and waits when a logged-out run starts, then prints the ERROR result", () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const s = withAgyScenario({ loggedIn: false, browserTo });
    const r = agy(["-p", "hi", "--output-format", "stream-json"], s.env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('"error":"authentication failed or timed out"');
    expect(readFileSync(browserTo, "utf8")).toBe("opened\n");
  });

  it("refuses an unknown flag and a bad effort with exit 2, and answers /usage without a turn", () => {
    const s = withAgyScenario({ unknownFlags: ["--disable-slash-commands"] });
    const old = agy(["-p", "hi", "--disable-slash-commands"], s.env);
    expect(old.code).toBe(2);
    expect(old.err).toStartWith("flags provided but not defined: -disable-slash-commands\n");
    expect(agy(["-p", "hi", "--effort", "xhigh"], s.env).code).toBe(2);
    const usage = agy(["-p", "/usage", "--output-format", "json"], s.env);
    expect(JSON.parse(usage.out)).toMatchObject({
      status: "SUCCESS",
      response: expect.stringContaining("Weekly"),
    });
    expect(existsSync(s.dir) && !s.ran()).toBe(true); // /usage started no run
  });
});

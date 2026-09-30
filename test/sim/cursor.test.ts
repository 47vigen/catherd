import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellLine } from "../../src/adapters/access.ts";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { withCursorScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const CHAT = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";

function agent(args: string[], env: Record<string, string>, stdin?: string, cwd?: string) {
  let input: "ignore" | ReturnType<typeof Bun.file> = "ignore";
  if (stdin !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-stdin-")), "in");
    writeFileSync(f, stdin);
    input = Bun.file(f);
  }
  const p = Bun.spawnSync(["cursor-agent", ...args], {
    env: { PATH: simPath(), ANTHROPIC_API_KEY: "", ...env },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

const AUTH =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n";

describe("cursor-agent simulator (research §2)", () => {
  it("answers --version and models, and fails models fast when logged out unless a key is set", () => {
    const s = withCursorScenario({ modelsFile: join(FX, "models.txt") });
    expect(agent(["--version"], s.env).out).toBe("2026.09.28-64d2043\n");
    expect(agent(["models"], s.env).out).toContain("gpt-6-sol-xhigh - GPT-6 Sol Extra High");
    const out = withCursorScenario({ loggedIn: false, modelsFile: join(FX, "models.txt") });
    expect(agent(["models"], out.env)).toEqual({ code: 1, out: "", err: AUTH });
    expect(agent(["models"], { ...out.env, CURSOR_API_KEY: "k" }).code).toBe(0);
  });

  it("replays the events under the resumed chat in the workspace, and records stdin, HOME and the hidden flag", () => {
    const repo = tempDir("catherd-simrepo-");
    const s = withCursorScenario({
      eventsFile: join(FX, "resume.jsonl"),
      touch: [{ path: "a.ts", content: "x" }],
    });
    const r = agent(
      ["-p", "--output-format", "stream-json", "--trust", "--workspace", repo, "--disable-auto-update"],
      { ...s.env, HOME: "/iso/home" },
      "---\nBRIEF",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('"session_id":"00000000-0000-4000-8000-00000000c0de"');
    expect(r.out).toContain(`"cwd":"${repo}"`);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({ stdin: "---\nBRIEF", home: "/iso/home" });
    expect(agent(["-p", "--trust", "--resume", CHAT], s.env, "b", repo).out).toContain(
      `"session_id":"${CHAT}"`,
    );
  });

  it("checks the login before the trust, and refuses an untrusted workspace, an unknown flag and a bad value", () => {
    const out = withCursorScenario({ loggedIn: false });
    expect(agent(["-p"], out.env, "b")).toEqual({ code: 1, out: "", err: AUTH });
    const s = withCursorScenario({ unknownFlags: ["--disable-auto-update"] });
    const untrusted = agent(["-p"], s.env, "b");
    expect(untrusted.code).toBe(1);
    expect(untrusted.err).toContain("Workspace Trust Required");
    expect(agent(["-p", "--trust", "--disable-auto-update"], s.env, "b")).toEqual({
      code: 1,
      out: "",
      err: "error: unknown option '--disable-auto-update'\n",
    });
    expect(agent(["-p", "--trust", "--sandbox", "bogus"], s.env, "b").err).toBe(
      "error: option '--sandbox <mode>' argument 'bogus' is invalid. Allowed choices are enabled, disabled.\n",
    );
  });

  it("runs a command in its sandbox with no model turn, refusing what the scenario denies", () => {
    const argsTo = join(mkdtempSync(join(tmpdir(), "catherd-sbx-")), "args.jsonl");
    const s = withCursorScenario({ sandboxDeny: ["/locks"], sandboxArgsTo: argsTo });
    // the live runner joins argv and re-shells it, so the probe is one quoted command line
    const line = shellLine(["sh", "-c", 'echo "$1"', "_", "hi"]);
    expect(agent(["sandbox", "run", "--", line], s.env).out).toBe("hi\n");
    const denied = agent(
      ["sandbox", "run", "--", shellLine(["sh", "-c", 'touch "$1"', "_", "/x/locks"])],
      s.env,
    );
    expect([denied.code, denied.err]).toEqual([1, "sandbox: Operation not permitted\n"]);
    expect(readFileSync(argsTo, "utf8").trim().split("\n").length).toBe(2);
    const old = withCursorScenario({ sandbox: "missing" });
    expect(agent(["sandbox", "run", "--", "true"], old.env).err).toBe("error: unknown command 'sandbox'\n");
  });
});

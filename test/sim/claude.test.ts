import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simPath } from "./scenario.ts";
import { withClaudeScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "claude-code");
const SESSION = "11111111-2222-4333-8444-555555555555";

function claude(args: string[], env: Record<string, string>, stdin?: string, cwd?: string) {
  let input: "ignore" | ReturnType<typeof Bun.file> = "ignore";
  if (stdin !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-stdin-")), "in");
    writeFileSync(f, stdin);
    input = Bun.file(f);
  }
  const p = Bun.spawnSync(["claude", ...args], {
    env: { ...process.env, ...env, PATH: simPath() },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

describe("claude simulator", () => {
  it("answers --version and auth status from the scenario", () => {
    const s = withClaudeScenario({ version: "2.1.100", loggedIn: false });
    expect(claude(["--version"], s.env).out.trim()).toBe("2.1.100 (Claude Code)");
    const a = claude(["auth", "status", "--json"], s.env);
    expect(a.code).toBe(1);
    expect(JSON.parse(a.out).loggedIn).toBe(false);
  });

  it("replays the events under the session it was given, records stdin and touches files", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const s = withClaudeScenario({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    const r = claude(
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "claude-sonnet-5",
        "--session-id",
        SESSION,
      ],
      s.env,
      "---\nBRIEF",
      repo,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(`"session_id":"${SESSION}"`);
    expect(r.out).not.toContain("6b1f7c1e");
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({ stdin: "---\nBRIEF", cwd: repo });
  });

  it("rejects an unknown flag, a bad effort, and bypassPermissions as root, like the real CLI", () => {
    const s = withClaudeScenario({ unknownFlags: ["--permission-prompts"], root: true });
    expect(claude(["-p", "--permission-prompts", "none"], s.env).err).toBe(
      "error: unknown option '--permission-prompts'\n",
    );
    expect(claude(["-p", "--effort", "ultra"], s.env).err).toContain("argument 'ultra' is invalid");
    const root = claude(["-p", "--permission-mode", "bypassPermissions"], s.env);
    expect(root.code).toBe(1);
    expect(root.err).toContain("cannot be used with root/sudo privileges");
  });
});

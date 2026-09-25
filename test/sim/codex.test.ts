import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simPath, withScenario } from "./scenario.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");

function run(args: string[], env: Record<string, string>, stdin?: string, cwd?: string) {
  let input: "ignore" | ReturnType<typeof Bun.file> = "ignore";
  if (stdin !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-stdin-")), "in");
    writeFileSync(f, stdin);
    input = Bun.file(f);
  }
  const p = Bun.spawnSync(["codex", ...args], {
    env: { ...process.env, ...env, PATH: simPath() },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

describe("codex simulator", () => {
  it("answers --version, login status and debug models from the scenario", () => {
    const s = withScenario({ version: "0.157.0", loggedIn: false, models: { models: [{ slug: "m" }] } });
    expect(run(["--version"], s.env).out.trim()).toBe("codex-cli 0.157.0");
    expect(run(["login", "status"], s.env).code).toBe(1);
    expect(JSON.parse(run(["debug", "models"], s.env).out)).toEqual({ models: [{ slug: "m" }] });
  });

  it("replays events on exec, writes -o, touches files and records what it saw", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const reply = join(repo, "reply.md");
    const s = withScenario({
      eventsFile: join(FX, "two-turns.jsonl"),
      reply: "ok\nSTATUS: complete — done",
      touch: [{ path: "src/a.ts", content: "x" }],
      exitCode: 0,
    });
    const r = run(
      ["exec", "-m", "gpt-6-sol", "--json", "-o", reply, "-s", "workspace-write", "--", "-"],
      s.env,
      "BRIEF",
      repo,
    );
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(5);
    expect(readFileSync(reply, "utf8")).toContain("STATUS: complete");
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("x");
    const seen = s.recorded();
    expect(seen.stdin).toBe("BRIEF");
    expect(seen.args).toContain("--");
    expect(seen.cwd).toBe(repo);
  });

  it("exits 2 on an unknown subcommand, like a CLI too old for a flag", () => {
    const s = withScenario({});
    expect(run(["frobnicate"], s.env).code).toBe(2);
  });
});

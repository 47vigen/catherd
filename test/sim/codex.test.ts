import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
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
    expect(run(["login", "status"], s.env)).toMatchObject({ code: 1, err: "Not logged in\n" });
    expect(run(["login", "status"], withScenario({ login: "api-key" }).env).err).toContain(
      "using an API key",
    );
    expect(JSON.parse(run(["debug", "models"], s.env).out)).toEqual({ models: [{ slug: "m" }] });
  });

  it("replays events on exec, writes -o, touches files and records what it saw", () => {
    const repo = tempDir("catherd-simrepo-");
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

describe("codex simulator scenarios", () => {
  it("applies a rung's overrides by model and effort, and reads a rewritten scenario", () => {
    const repo = tempDir("catherd-simrepo-");
    const reply = join(repo, "reply.md");
    const exec = (model: string, effort: string | null) => [
      "exec",
      "-m",
      model,
      ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
      "--json",
      "-o",
      reply,
      "--",
      "-",
    ];
    const s = withScenario({
      exitCode: 0,
      byRung: { "gpt-6-sol#high": { exitCode: 3 }, "m#default": { exitCode: 4 } },
    });
    expect(run(exec("gpt-6-sol", "medium"), s.env, "", repo).code).toBe(0);
    expect(run(exec("gpt-6-sol", "high"), s.env, "", repo).code).toBe(3);
    expect(run(exec("m", null), s.env, "", repo).code).toBe(4);
    s.rewrite({ exitCode: 5 });
    expect(run(exec("gpt-6-sol", "high"), s.env, "", repo).code).toBe(5);
  });
});

describe("codex simulator queue", () => {
  it("answers no-send help and native exact acceptance or failure fixtures", () => {
    const thread = "01a0f53b-a47d-7350-83a4-c3430e453404";
    const args = ["queue", "--remote", "unix://", "--thread", thread, "--message", "completion"];
    expect(run(["queue", "--help"], withScenario({ queue: "accepted" }).env).out).toContain("--remote");
    expect(run(args, withScenario({ queue: "accepted" }).env)).toMatchObject({
      code: 0,
      out: `Queued message 01a0f547-7947-7972-90a0-a7ad547170e0 for thread ${thread}.\n`,
    });
    expect(run(args, withScenario({ queue: "malformed" }).env)).toMatchObject({
      code: 0,
      out: "Queued message.\n",
    });
    expect(run(args, withScenario({ queue: "unsupported" }).env).err).toContain(
      "does not support thread/queue/add",
    );
    expect(run(["queue", "--help"], withScenario({}).env).code).toBe(2);
    expect(run(["queue", "--help"], withScenario({ queue: "no-remote" }).env).out).not.toContain("--remote");
  });
});

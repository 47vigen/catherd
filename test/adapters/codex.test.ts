import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { codexAdapter, codexShell } from "../../src/adapters/codex/index.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("codex:gpt-6-sol#high"),
  access: "workspace-write",
  thread: null,
  isolated: false,
  repo: "/repo",
  briefPath: "/d/brief.md",
  replyPath: "/d/reply.md",
  dispatchDir: "/d",
  ...over,
});

const finished = (eventLines: string[], over: Partial<FinishedRun> = {}): FinishedRun => ({
  request: req(),
  eventLines,
  reply: "done\nSTATUS: complete — ok",
  stderr: "",
  exit: { code: 0, signal: null, reason: "exited", endedAt: "2026-09-25T00:00:00.000Z" },
  startedAtMs: 0,
  ...over,
});

describe("codex plan", () => {
  it("sends the brief on stdin, sets model, effort and sandbox, and ends positionals after --", () => {
    const p = codexAdapter.plan(req());
    expect(p.cmd).toBe("codex");
    expect(p.stdinPath).toBe("/d/brief.md");
    expect(p.cwd).toBe("/repo");
    expect(p.args).toEqual([
      "exec",
      "-m",
      "gpt-6-sol",
      "-c",
      "model_reasoning_effort=high",
      "--json",
      "-o",
      "/d/reply.md",
      "-s",
      "workspace-write",
      "--",
      "-",
    ]);
    expect(p.args.join(" ")).not.toContain("brief");
  });

  it("maps access to Codex sandboxes", () => {
    const s = (access: RunRequest["access"]) => {
      const a = codexAdapter.plan(req({ access })).args;
      return a[a.indexOf("-s") + 1];
    };
    expect(s("read-only")).toBe("read-only");
    expect(s("workspace-write")).toBe("workspace-write");
    expect(s("full")).toBe("danger-full-access");
  });

  it("resumes with the sandbox as -c and the thread after --", () => {
    const p = codexAdapter.plan(req({ thread: "019a-thread-1" }));
    expect(p.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(p.args).toContain("sandbox_mode=workspace-write");
    expect(p.args.slice(-3)).toEqual(["--", "019a-thread-1", "-"]);
  });

  it("refuses a thread that could be read as a flag", () => {
    try {
      codexAdapter.plan(req({ thread: "--dangerously-bypass-approvals-and-sandbox" }));
      throw new Error("expected a throw");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_ADMIT_THREAD");
    }
  });

  it("isolated runs ignore user config and use catherd's CODEX_HOME", () => {
    withHome();
    const p = codexAdapter.plan(req({ isolated: true }));
    expect(p.args).toContain("--ignore-user-config");
    expect(p.env.CODEX_HOME).toContain("codex-home");
  });
});

describe("codex finalize", () => {
  it("does not fail a run for a reconnect error event, and sums tokens", () => {
    const o = codexAdapter.finalize(finished(lines("ok-with-reconnect.jsonl")));
    expect(o.status).toBe("ok");
    expect(o.thread).toBe("01a0d0d4-d0a6-71a1-983c-82a9169200b4");
    expect(o.tokens).toEqual({ input: 898388, cached: 788992, output: 5341 });
    expect(o.error).toBeNull();
  });

  it("sums tokens over turns", () => {
    expect(codexAdapter.finalize(finished(lines("two-turns.jsonl"))).tokens).toEqual({
      input: 300,
      cached: 190,
      output: 30,
    });
  });

  it("classifies turn.failed as failed and a usage limit as limit", () => {
    expect(codexAdapter.finalize(finished(lines("turn-failed.jsonl"))).status).toBe("failed");
    const lim = codexAdapter.finalize(finished(lines("limit.jsonl")));
    expect(lim.status).toBe("limit");
    expect(lim.error?.message).toMatch(/usage limit/);
  });

  it("classifies the ChatGPT-account message as cli-too-old", () => {
    const o = codexAdapter.finalize(
      finished([], {
        stderr: "error: model not supported when using Codex with a ChatGPT account",
        reply: "",
      }),
    );
    expect(o.status).toBe("cli-too-old");
  });

  it("maps supervisor stops to timeout and cancelled, and a non-zero exit with no reply to failed", () => {
    const at = (reason: FinishedRun["exit"]["reason"]) =>
      codexAdapter.finalize(finished([], { exit: { code: null, signal: "SIGTERM", reason, endedAt: "x" } }))
        .status;
    expect(at("idle-timeout")).toBe("timeout");
    expect(at("wall-timeout")).toBe("timeout");
    expect(at("cancelled")).toBe("cancelled");
    expect(
      codexAdapter.finalize(
        finished([], { reply: "", exit: { code: 1, signal: null, reason: "exited", endedAt: "x" } }),
      ).status,
    ).toBe("failed");
  });
});

describe("codex probe and discovery (simulator)", () => {
  it("reports version, login and a too-old CLI", async () => {
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ version: "0.150.0", loggedIn: false }).env);
    const p = await codexAdapter.probe();
    expect(p).toMatchObject({ installed: true, version: "0.150.0", versionOk: false, loggedIn: false });
    expect(p.problems.map((x) => x.code)).toEqual(["E_BACKEND_TOO_OLD", "E_BACKEND_NOT_LOGGED_IN"]);
  });

  it("reports a missing CLI with the install command", async () => {
    process.env.PATH = "/nonexistent";
    const p = await codexAdapter.probe();
    expect(p.installed).toBe(false);
    expect(p.problems[0]).toMatchObject({ code: "E_BACKEND_MISSING", fix: "npm i -g @openai/codex" });
  });

  it("treats a codex login status that hangs as not logged in, within the timeout", async () => {
    const saved = codexShell.timeoutMs;
    codexShell.timeoutMs = 300;
    try {
      process.env.PATH = simPath();
      Object.assign(process.env, withScenario({ loginHangMs: 30_000 }).env);
      const t0 = Date.now();
      const p = await codexAdapter.probe();
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(p).toMatchObject({ installed: true, versionOk: true, loggedIn: false });
    } finally {
      codexShell.timeoutMs = saved;
    }
  });

  it("does not pass catherd's own secrets to codex", async () => {
    process.env.PATH = simPath();
    process.env.TYPESAFE_API_KEY = "catherd-secret";
    process.env.OPENAI_API_KEY = "users-key";
    const envTo = join(mkdtempSync(join(tmpdir(), "catherd-env-")), "env.jsonl");
    Object.assign(process.env, withScenario({ envTo }).env);
    await codexAdapter.probe();
    await codexAdapter.listModels();
    const calls = readFileSync(envTo, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; envKeys: string[] });
    expect(calls.map((c) => c.args.join(" "))).toEqual(["--version", "login status", "debug models"]);
    for (const c of calls) {
      expect(c.envKeys).not.toContain("TYPESAFE_API_KEY");
      expect(c.envKeys).toContain("OPENAI_API_KEY");
    }
  });

  it("lists visible models with their efforts from codex debug models", async () => {
    process.env.PATH = simPath();
    const models = JSON.parse(readFileSync(join(FX, "models.json"), "utf8"));
    Object.assign(process.env, withScenario({ models }).env);
    const list = await codexAdapter.listModels();
    expect(list.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
    expect(list[1]).toEqual({
      id: "gpt-6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      context: 272000,
      imageIn: true,
    });
  });
});

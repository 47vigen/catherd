import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { CLAUDE_ACCESS, claudeCodeAdapter, claudeShell } from "../../src/adapters/claude-code/index.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import type { Access } from "../../src/domain/record.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { withClaudeScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "claude-code");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());
afterEach(() => {
  claudeShell.timeoutMs = 15_000;
});

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("claude-code:claude-sonnet-5#high"),
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
  reply: "",
  stderr: "",
  exit: { code: 0, signal: null, reason: "exited", endedAt: "2026-09-25T00:00:00.000Z" },
  startedAtMs: 0,
  ...over,
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

describe("claude-code plan", () => {
  it("prints stream-json with a full model id, the effort, a fresh session id and the brief on stdin", () => {
    const p = claudeCodeAdapter.plan(req());
    expect(p.cmd).toBe("claude");
    expect(p.stdinPath).toBe("/d/brief.md");
    const session = p.args[p.args.indexOf("--session-id") + 1] as string;
    expect(claudeCodeAdapter.resume.threadPattern.test(session)).toBe(true);
    expect(p.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-5",
      "--effort",
      "high",
      "--session-id",
      session,
      "--permission-prompts",
      "none",
      ...CLAUDE_ACCESS["workspace-write"],
    ]);
  });

  it("resumes a session, leaves the effort to claude on default, and isolates with --safe-mode", () => {
    const thread = "670d1ec2-db2b-471f-a1a5-3cda1416c061";
    const p = claudeCodeAdapter.plan(
      req({ rung: parseRung("claude-code:claude-haiku-4-5-20251001#default"), thread, isolated: true }),
    );
    expect(p.args).not.toContain("--effort");
    expect(p.args).not.toContain("--session-id");
    expect(p.args.slice(p.args.indexOf("--resume"), p.args.indexOf("--resume") + 2)).toEqual([
      "--resume",
      thread,
    ]);
    expect(p.args.at(-1)).toBe("--safe-mode");
  });

  it.each([
    ["read-only", "dontAsk", "Edit,Write,NotebookEdit,Bash"],
    ["workspace-write", "acceptEdits", "Bash(git commit *),Bash(git push *),Bash(git reset --hard *)"],
  ] as const)("maps %s to --permission-mode %s and denies %s", (access, mode, denied) => {
    const args = claudeCodeAdapter.plan(req({ access })).args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(mode);
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(denied);
  });

  it("gives read-only roles no shell, only the read tools, and lets full access bypass permissions", () => {
    // `rg --pre=<cmd>` executes and `git diff --output=<file>` writes: no Bash pattern is read-only
    const ro = claudeCodeAdapter.plan(req({ access: "read-only" })).args;
    expect(CLAUDE_ACCESS["read-only"]).toEqual([
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Glob,Grep,WebFetch,WebSearch",
      "--disallowedTools",
      "Edit,Write,NotebookEdit,Bash",
    ]);
    const allowed = (ro[ro.indexOf("--allowedTools") + 1] as string).split(",");
    expect(allowed).toEqual(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
    expect(allowed.filter((t) => t.startsWith("Bash"))).toEqual([]);
    expect((ro[ro.indexOf("--disallowedTools") + 1] as string).split(",")).toContain("Bash");
    const full = claudeCodeAdapter.plan(req({ access: "full" })).args;
    expect(full.slice(full.indexOf("--permission-mode"), full.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(full).not.toContain("--allowedTools");
  });
});

describe("claude-code prepare", () => {
  const prep = (rung: string, access: Access = "workspace-write") =>
    code(
      claudeCodeAdapter.prepare?.({ rung: parseRung(rung), access, isolated: false }) ?? Promise.resolve(),
    );

  it("accepts full ids with an effort the model has", async () => {
    expect(await prep("claude-code:claude-opus-5-5#xhigh")).toBe("ok");
    expect(await prep("claude-code:claude-haiku-4-5-20251001#default")).toBe("ok");
    expect(await prep("claude-code:claude-opus-6#high")).toBe("ok");
  });

  it("refuses an alias, an effort the model lacks, and an unknown effort", async () => {
    expect(await prep("claude-code:opus#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("claude-code:claude-haiku-4-5#default")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("claude-code:claude-haiku-4-5-20251001#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("claude-code:claude-sonnet-5#ultra")).toBe("E_BACKEND_MODEL_UNKNOWN");
  });

  it("refuses full access as root unless IS_SANDBOX says the machine is disposable", async () => {
    if (process.getuid?.() !== 0) return;
    delete process.env.IS_SANDBOX;
    expect(await prep("claude-code:claude-sonnet-5#high", "full")).toBe("E_ADMIT_RUNG");
    process.env.IS_SANDBOX = "1";
    expect(await prep("claude-code:claude-sonnet-5#high", "full")).toBe("ok");
  });
});

describe("claude-code finalize", () => {
  it("takes the reply, tokens and cost from the result event", () => {
    const o = claudeCodeAdapter.finalize(finished(lines("ok.jsonl")));
    expect(o).toMatchObject({ status: "ok", reply: "hello", error: null });
    expect(o.costUsd).toBeCloseTo(0.0132669);
  });

  it("reports cancel and timeouts from the exit reason, and a missing result as failed", () => {
    const at = (reason: "cancelled" | "idle-timeout") =>
      claudeCodeAdapter.finalize(
        finished([], { exit: { code: null, signal: "SIGTERM", reason, endedAt: "x" } }),
      );
    expect(at("cancelled").status).toBe("cancelled");
    expect(at("idle-timeout").status).toBe("timeout");
    const root = claudeCodeAdapter.finalize(
      finished([], {
        stderr:
          "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n",
        exit: { code: 1, signal: null, reason: "exited", endedAt: "x" },
      }),
    );
    expect(root.status).toBe("failed");
    expect(root.error?.message).toContain("root/sudo");
  });

  it("does not call a rejected rate-limit event a limit when the run still succeeded", () => {
    const ok = lines("ok.jsonl").map((l) => l.replace('"status":"allowed_warning"', '"status":"rejected"'));
    expect(claudeCodeAdapter.finalize(finished(ok)).status).toBe("ok");
  });
});

describe("claude-code parse", () => {
  it("reports the thread, a retry, and the final result with its tokens", () => {
    const [init, retry, , result] = lines("retry.jsonl");
    expect(claudeCodeAdapter.parse(init as string)).toMatchObject({
      thread: "5b4c3d2e-1f0a-4b9c-8d7e-6f5a4b3c2d1e",
      lastEvent: "system/init",
    });
    expect(claudeCodeAdapter.parse(retry as string)).toMatchObject({ retrying: true, lastEvent: "retrying" });
    expect(claudeCodeAdapter.parse(result as string)).toMatchObject({
      final: true,
      tokens: { input: 20912, cached: 20000, output: 14 },
      costUsd: 0.0142,
    });
  });

  it("counts tokens only once: assistant events carry no tokens", () => {
    const sum = lines("ok.jsonl").reduce((n, l) => n + (claudeCodeAdapter.parse(l).tokens?.output ?? 0), 0);
    expect(sum).toBe(41);
  });
});

describe("claude-code probe", () => {
  const onSim = (s: Parameters<typeof withClaudeScenario>[0]) => {
    process.env.PATH = simPath();
    Object.assign(process.env, withClaudeScenario(s).env);
  };

  it("is ready at the verified version when logged in", async () => {
    onSim({});
    expect(await claudeCodeAdapter.probe()).toMatchObject({
      installed: true,
      version: "2.1.282",
      versionOk: true,
      loggedIn: true,
      problems: [],
    });
  });

  it("names the fix for an old CLI and a missing login", async () => {
    onSim({ version: "2.1.200", loggedIn: false });
    const p = await claudeCodeAdapter.probe();
    expect(p.problems.map((x) => [x.code, x.fix])).toEqual([
      ["E_BACKEND_TOO_OLD", "claude update"],
      ["E_BACKEND_NOT_LOGGED_IN", "claude auth login"],
    ]);
  });

  it("reports a missing CLI", async () => {
    process.env.PATH = "/nonexistent";
    expect((await claudeCodeAdapter.probe()).problems[0]?.code).toBe("E_BACKEND_MISSING");
  });

  it("lists the shipped models with their efforts", async () => {
    const ms = await claudeCodeAdapter.listModels();
    expect(ms.map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(ms.find((m) => m.id.startsWith("claude-haiku"))?.efforts).toEqual([]);
  });
});

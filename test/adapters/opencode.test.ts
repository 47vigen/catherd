import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { isolatedConfigRoot } from "../../src/adapters/opencode/agents.ts";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "opencode");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("opencode:opencode-go/glm-5.3#high"),
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

describe("opencode plan", () => {
  it("runs `run --format json --auto` with the access mode's agent and model#variant, brief on stdin", () => {
    const p = opencodeAdapter.plan(req());
    expect(p).toEqual({
      cmd: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--auto",
        "--agent",
        "catherd-worker",
        "-m",
        "opencode-go/glm-5.3#high",
      ],
      env: {},
      cwd: "/repo",
      stdinPath: "/d/brief.md",
    });
  });

  it("picks catherd-ro and catherd-full, drops `#` for the default variant, and resumes with -s", () => {
    expect(opencodeAdapter.plan(req({ access: "read-only" })).args).toContain("catherd-ro");
    expect(opencodeAdapter.plan(req({ access: "full" })).args).toContain("catherd-full");
    const p = opencodeAdapter.plan(
      req({
        rung: parseRung("opencode:opencode/big-pickle#default"),
        thread: "ses_f2671cde4ffe4VbeG6dKWzM2vi",
      }),
    );
    expect(p.args.slice(-4)).toEqual(["-m", "opencode/big-pickle", "-s", "ses_f2671cde4ffe4VbeG6dKWzM2vi"]);
  });

  it("isolates with a standalone server reading catherd's own config root", () => {
    withHome();
    const p = opencodeAdapter.plan(req({ isolated: true }));
    expect(p.args).toContain("--standalone");
    expect(p.env).toEqual({ XDG_CONFIG_HOME: isolatedConfigRoot() });
  });
});

describe("opencode finalize", () => {
  it("names the rejected permission instead of opencode's bare 'Step interrupted'", () => {
    const o = opencodeAdapter.finalize(
      finished(lines("permission-rejected.jsonl"), {
        exit: { code: 1, signal: null, reason: "exited", endedAt: "x" },
      }),
    );
    expect(o.error).toEqual({ code: "failed", message: "permission rejected: read <scratch>/outside.txt" });
  });

  it("reports cancel and timeouts from the exit reason, and a non-zero exit with no events as failed", () => {
    const at = (reason: "cancelled" | "wall-timeout") =>
      opencodeAdapter.finalize(
        finished([], { exit: { code: null, signal: "SIGTERM", reason, endedAt: "x" } }),
      ).status;
    expect(at("cancelled")).toBe("cancelled");
    expect(at("wall-timeout")).toBe("timeout");
    const o = opencodeAdapter.finalize(
      finished([], { stderr: "boom\n", exit: { code: 1, signal: null, reason: "exited", endedAt: "x" } }),
    );
    expect(o).toMatchObject({ status: "failed", error: { message: "boom" }, thread: null });
  });

  it("keeps the thread of a resumed run with no events", () => {
    const thread = "ses_f2671cde4ffe4VbeG6dKWzM2vi";
    expect(opencodeAdapter.finalize(finished([], { request: req({ thread }) })).thread).toBe(thread);
  });
});

describe("opencode parse", () => {
  it("reports the session, step tokens and cost, and limits", () => {
    const shell = lines("shell-ok.jsonl");
    expect(opencodeAdapter.parse(shell[0] as string)).toMatchObject({
      thread: "ses_f2671cde4ffe4VbeG6dKWzM2vi",
      lastEvent: "step_start",
    });
    expect(opencodeAdapter.parse(shell[2] as string).lastEvent).toBe("tool_use/shell");
    expect(opencodeAdapter.parse(shell[3] as string)).toMatchObject({
      tokens: { input: 6505, cached: 488, output: 41 },
      costUsd: 0,
    });
    expect(opencodeAdapter.parse(lines("quota.jsonl")[1] as string)).toMatchObject({
      limit: true,
      failure: "Monthly usage limit reached for opencode-go/kimi-k3",
    });
    expect(opencodeAdapter.parse(lines("v1-model-hash-error.jsonl")[0] as string).tooOld).toBe(true);
  });
});

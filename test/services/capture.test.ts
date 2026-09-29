import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { opencodeShell } from "../../src/adapters/opencode/index.ts";
import { formatCaptured } from "../../src/entry/capture-fixtures-command.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { captureFixtures, captureOne } from "../../src/services/capture.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import {
  type OpencodeModel,
  withClaudeScenario,
  withCursorScenario,
  withOpencodeScenario,
} from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  opencodeShell.retryDelayMs = 0;
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const SECRET = "sk-ant-api03-capture-test-secret-value";
const MODELS = JSON.parse(readFileSync(join(FX, "opencode", "models.json"), "utf8")).data as OpencodeModel[];

/** A claude stream that leaks the repo path (the simulator fills in `<repo>`), a home path and a key. */
function leakyClaudeEvents(): string {
  const file = join(mkdtempSync(join(tmpdir(), "catherd-leak-")), "events.jsonl");
  const ok = readFileSync(join(FX, "claude-code", "ok.jsonl"), "utf8");
  writeFileSync(
    file,
    ok.replace(
      '"text":"hello"',
      `"text":"hello from ${homedir()}/.claude/x with ${SECRET} by ana@example.com"`,
    ),
  );
  return file;
}

describe("capture-fixtures", () => {
  it("writes sanitized streams, stderr and a meta file per case under <backend>/<cli-version>/", async () => {
    withHome();
    process.env.PATH = simPath();
    process.env.ANTHROPIC_API_KEY = SECRET;
    Object.assign(
      process.env,
      withClaudeScenario({ eventsFile: leakyClaudeEvents() }).env,
      withOpencodeScenario({ models: MODELS, eventsFile: join(FX, "opencode", "shell-ok.jsonl") }).env,
    );
    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
    const results = await captureFixtures({ outDir: out, backends: ["claude-code", "opencode"] });
    expect(results.map((r) => [r.backend, r.name, r.status])).toEqual([
      ["claude-code", "ok", "captured"],
      ["claude-code", "read-only-write", "captured"],
      ["opencode", "ok", "captured"],
      ["opencode", "read-only-write", "captured"],
    ]);
    expect(readdirSync(join(out, "claude-code", "2.1.282")).sort()).toEqual([
      "ok.json",
      "ok.jsonl",
      "ok.stderr",
      "read-only-write.json",
      "read-only-write.jsonl",
      "read-only-write.stderr",
    ]);
    const stream = readFileSync(join(out, "claude-code", "2.1.282", "ok.jsonl"), "utf8");
    expect(stream).toContain('"cwd":"<repo>"');
    expect(stream).toContain("hello from ~/.claude/x with <redacted> by <email>");
    expect(stream).not.toContain(SECRET);
    expect(stream).not.toContain(homedir());
    const meta = JSON.parse(readFileSync(join(out, "opencode", "2.0.16", "ok.json"), "utf8"));
    expect(meta).toMatchObject({
      schema: 1,
      backend: "opencode",
      cliVersion: "2.0.16",
      rung: "opencode:opencode/space-bunny-free#default",
      exitCode: 0,
      outcome: { status: "ok", thread: "ses_f2671cde4ffe4VbeG6dKWzM2vi" },
    });
    expect(formatCaptured(results[2] as (typeof results)[number])).toBe(
      `✓ opencode 2.0.16 ok → ${join(out, "opencode", "2.0.16")}/ok.jsonl (exit 0)`,
    );
  });

  it("captures Cursor's work, resume and read-only cases on auto, the resume on the first run's chat", async () => {
    withHome();
    process.env.PATH = simPath();
    process.env.CURSOR_API_KEY = SECRET;
    const sim = withCursorScenario({
      modelsFile: join(FX, "cursor", "models.txt"),
      eventsFile: join(FX, "cursor", "ok.jsonl"),
    });
    Object.assign(process.env, sim.env);
    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
    const results = await captureFixtures({ outDir: out, backends: ["cursor"] });
    expect(results.map((r) => [r.backend, r.name, r.status])).toEqual([
      ["cursor", "ok", "captured"],
      ["cursor", "resume", "captured"],
      ["cursor", "read-only-write", "captured"],
    ]);
    const resumed = JSON.parse(readFileSync(join(out, "cursor", "2026.09.28", "resume.json"), "utf8"));
    expect(resumed).toMatchObject({
      rung: "cursor:auto#default",
      resumed: "00000000-0000-4000-8000-00000000c0de",
      outcome: { thread: "00000000-0000-4000-8000-00000000c0de" },
    });
    expect(sim.recorded().args).toContain("--mode");
    expect(readFileSync(join(out, "cursor", "2026.09.28", "ok.jsonl"), "utf8")).not.toContain(SECRET);
  });

  it("records the totals the opencode service settles on, not only what the stream said", async () => {
    withHome();
    process.env.PATH = simPath();
    const session = {
      cost: 0.12,
      tokens: { input: 7000, output: 60, reasoning: 40, cache: { read: 3000, write: 0 } },
      outcome: "succeeded",
    };
    const events = join(FX, "opencode", "shell-ok.jsonl");
    Object.assign(process.env, withOpencodeScenario({ models: MODELS, eventsFile: events, session }).env);
    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
    await captureFixtures({ outDir: out, backends: ["opencode"] });
    const meta = JSON.parse(readFileSync(join(out, "opencode", "2.0.16", "ok.json"), "utf8"));
    expect(meta.outcome).toMatchObject({
      status: "ok",
      tokens: { input: 10000, cached: 3000, output: 100 },
      costUsd: 0.12,
    });
  });

  it("captures isolated, and stops a run past the timeout with everything it started", async () => {
    withHome();
    process.env.PATH = simPath();
    const recorded = join(mkdtempSync(join(tmpdir(), "catherd-rec-")), "claude.json");
    Object.assign(process.env, withClaudeScenario({ hangMs: 30_000, recordTo: recorded }).env);
    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
    const t0 = Date.now();
    const results = await captureFixtures({ outDir: out, backends: ["claude-code"], timeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(results.map((r) => r.status)).toEqual(["captured", "captured"]);
    const meta = JSON.parse(readFileSync(join(out, "claude-code", "2.1.282", "ok.json"), "utf8"));
    expect(meta).toMatchObject({ isolated: true, reason: "wall-timeout", exitCode: null });
    expect(JSON.parse(readFileSync(recorded, "utf8")).args).toContain("--safe-mode");
  });

  it("skips a backend that is not ready, saying why", async () => {
    withHome();
    process.env.PATH = simPath();
    Object.assign(process.env, withOpencodeScenario({ version: "1.18.32" }).env);
    const results = await captureFixtures({
      outDir: mkdtempSync(join(tmpdir(), "x-")),
      backends: ["opencode"],
    });
    expect(results[0]).toMatchObject({ status: "skipped" });
    expect(formatCaptured(results[0] as (typeof results)[number])).toMatch(
      /^- opencode ok skipped: E_BACKEND_TOO_OLD: opencode 1\.18\.32 is v1/,
    );
  });
});

/**
 * A backend whose CLI is `sh`: it saves what it read on stdin to `<seen>/<thread or "new">`, and says which
 * thread it ran on; `stdin` says whether its plan asks for the brief there.
 */
function shellBackend(seen: string, stdin: boolean): BackendAdapter {
  return {
    id: "cursor",
    minVersion: "0.0.0",
    probe: async () => ({ installed: true, version: "1.0.0", versionOk: true, loggedIn: true, problems: [] }),
    listModels: async () => [],
    plan: (r) => ({
      cmd: "sh",
      args: ["-c", 'cat > "$1/$2"', "_", seen, r.thread ?? "new"],
      env: {},
      cwd: r.repo,
      stdinPath: stdin ? r.briefPath : null,
    }),
    parse: () => ({}),
    finalize: (run) => ({
      status: "ok",
      thread: run.request.thread ?? "th-1",
      tokens: { input: 0, cached: 0, output: 0 },
      costUsd: null,
      images: [],
      error: null,
    }),
    enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "advisory" },
    errors: { limit: [], tooOld: [] },
    resume: { supported: true, sameAccessOnly: false, threadPattern: /^th-\d+$/ },
    graceAfterFinalMs: null,
  };
}

describe("a capture case (spec 1.3 §3.3)", () => {
  const CASE = { backend: "cursor", name: "ok", rung: "cursor:m#default", access: "read-only" as const };

  it("passes the brief on stdin only to a CLI whose plan asks for it", async () => {
    withHome();
    for (const stdin of [true, false]) {
      const seen = mkdtempSync(join(tmpdir(), "catherd-seen-"));
      const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
      const r = await captureOne(
        shellBackend(seen, stdin),
        "1.0.0",
        { ...CASE, brief: "BRIEF" },
        out,
        10_000,
      );
      expect(r.status).toBe("captured");
      expect(readFileSync(join(seen, "new"), "utf8")).toBe(stdin ? "BRIEF" : "");
    }
  });

  it("captures a resume: a first run in the scratch repo, then its thread resumed there with the second brief", async () => {
    withHome();
    const seen = mkdtempSync(join(tmpdir(), "catherd-seen-"));
    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
    const r = await captureOne(
      shellBackend(seen, true),
      "1.0.0",
      { ...CASE, name: "resume", brief: "FIRST", resume: "SECOND" },
      out,
      10_000,
    );
    expect(r.status).toBe("captured");
    expect([readFileSync(join(seen, "new"), "utf8"), readFileSync(join(seen, "th-1"), "utf8")]).toEqual([
      "FIRST",
      "SECOND",
    ]);
    const meta = JSON.parse(readFileSync(join(out, "cursor", "1.0.0", "resume.json"), "utf8"));
    expect(meta).toMatchObject({
      case: "resume",
      brief: "SECOND",
      resumed: "th-1",
      outcome: { thread: "th-1" },
    });
  });
});

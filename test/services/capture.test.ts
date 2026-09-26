import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeShell } from "../../src/adapters/opencode/index.ts";
import { formatCaptured } from "../../src/entry/capture-fixtures.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { captureFixtures } from "../../src/services/capture.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type OpencodeModel, withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

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

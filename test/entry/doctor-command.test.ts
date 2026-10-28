import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mark } from "../../src/entry/cli-kit.ts";
import { formatCheck, formatReport } from "../../src/entry/doctor-command.ts";
import { glyph } from "../../src/entry/glyphs.ts";
import { VERSION } from "../../src/infra/version.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { bunOnlyBin, snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { withScenario } from "../sim/scenario.ts";
import { withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters");
const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));

function machine(): void {
  const home = withHome();
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.CATHERD_DECISION_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // test/bin: the MCP launcher's "global catherd" is this checkout, so doctor's handshake never runs bunx
  process.env.PATH = `${join(import.meta.dir, "..", "sim")}:${join(import.meta.dir, "..", "bin")}:${bunOnlyBin()}:/usr/bin:/bin`;
  Object.assign(
    process.env,
    withScenario({ models: fx("codex/models.json"), sandbox: "allow" }).env,
    withClaudeScenario({}).env,
    withOpencodeScenario({ models: fx("opencode/models.json").data }).env,
  );
}

function doctor(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "doctor", ...args], {
    // Bun hands a child its own start-up env unless told otherwise; the test's CATHERD_HOME must reach it
    // blank: the claude-code listing is an HTTP call when the key is set, and tests never reach the network
    env: { ...process.env, CATHERD_ORCHESTRATION_HOST: "claude-code", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() };
}

/** The same, asynchronous. */
async function doctorAsync(...args: string[]) {
  const p = Bun.spawn([process.execPath, join(SRC, "cli.ts"), "doctor", ...args], {
    env: { ...process.env, CATHERD_ORCHESTRATION_HOST: "claude-code", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code: p.exitCode, out };
}

describe("formatCheck", () => {
  it("prints the glyph, the word, the check and its detail, and the full fix on its own line", () => {
    expect(
      formatCheck({
        id: "backend:codex",
        label: "codex",
        state: "fail",
        word: "not logged in",
        detail: "codex is not logged in",
        fix: "codex login",
      }),
    ).toEqual(["✗ not logged in      codex — codex is not logged in", "    fix: codex login"]);
    expect(
      formatCheck({ id: "bun", label: "Bun", state: "ok", word: "ready", detail: "1.4.2" }, true),
    ).toEqual(["+ ready              Bun — 1.4.2"]);
  });

  it("keeps each line of a fix of several commands under the first, whole", () => {
    expect(
      formatCheck(
        {
          id: "backend:codex",
          label: "codex",
          state: "fail",
          word: "missing",
          detail: "",
          fix: "install\nor run\na b",
        },
        true,
      ),
    ).toEqual(["x missing            codex", "    fix: install", "         or run", "         a b"]);
  });
});

describe("an info row (spec 1.1 §13)", () => {
  it("draws i, in both glyph sets", () => {
    expect(
      formatCheck({ id: "access:full", label: "full access", state: "info", word: "default", detail: "x" }),
    ).toEqual(["i default            full access — x"]);
    expect(mark("info", true)).toBe("i");
  });
});

describe("formatReport (Ruling R4)", () => {
  it("says ready when the only rows beside ok are info: info is not a warning", () => {
    const lines = formatReport({
      host: { host: "unknown", session: null, conflict: null },
      queue: null,
      push: null,
      ready: true,
      version: VERSION,
      checks: [
        { id: "bun", label: "Bun", state: "ok", word: "ready", detail: "1.4.2" },
        {
          id: "access:full",
          label: "full access",
          state: "info",
          word: "default",
          detail: "no sandbox for: verifier",
        },
      ],
    });
    expect(lines).toEqual([
      "✓ ready              Bun — 1.4.2",
      "i default            full access — no sandbox for: verifier",
      "",
      "✓ ready",
    ]);
    expect(lines.join("\n")).not.toContain(mark("warn"));
  });
});

describe("mark", () => {
  it("draws the theme's glyphs, ASCII under --plain (audit N2)", () => {
    for (const state of ["ok", "warn", "fail", "skip", "info"] as const)
      for (const plain of [false, true]) expect(mark(state, plain)).toBe(glyph(state, plain));
  });
});

describe("catherd doctor", () => {
  it("keeps init's glyphs under NO_COLOR, which drops only colour; --plain is ASCII (audit N2)", () => {
    machine();
    process.env.NO_COLOR = "1";
    const text = doctor().out;
    expect(text).toContain("✓ ready              Bun");
    expect(text).not.toContain("+ ready");
    expect(doctor("--plain").out).toContain("+ ready              Bun");
  }, 30_000);

  it("exits 3 when not ready, and its JSON shows the real MCP server answering over stdio", () => {
    machine();
    const r = doctor("--json");
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out);
    expect(j.ready).toBe(false);
    expect(j.checks.find((c: { id: string }) => c.id === "plugin")).toMatchObject({
      state: "fail",
      word: "missing",
    });
    expect(j.checks.find((c: { id: string }) => c.id === "mcp")).toMatchObject({
      state: "ok",
      detail: expect.stringMatching(/^answers tools\/list with \d+ tools$/),
    });
  }, 60_000);

  it("exits 0 and says ready once the plugin is installed and the agents are linked", async () => {
    machine();
    const plugins = join(process.env.CLAUDE_CONFIG_DIR as string, "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "catherd@catherd": [{ version: VERSION }] } }),
    );
    patchProfile("default", {}, { host: "claude-code" });
    const r = await doctorAsync("--plain");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("+ ready");
  }, 60_000);
});

it("default CLI doctor sends nothing; explicit smoke preserves receipt-only reporting", async () => {
  machine();
  const envTo = join(process.env.CATHERD_HOME!, "queue-calls");
  const s = withScenario({ models: fx("codex/models.json"), sandbox: "allow", queue: "accepted", envTo });
  Object.assign(process.env, s.env, {
    CODEX_THREAD_ID: "01a0f53b-a47d-7350-83a4-c3430e453404",
    CATHERD_ORCHESTRATION_HOST: "codex",
  });
  const runCodex = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "doctor", "--json", ...args], {
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return JSON.parse(p.stdout.toString());
  };
  runCodex();
  let calls = readFileSync(envTo, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.some((c) => c.args.includes("--message"))).toBe(false);
  const explicit = runCodex("--test-push");
  expect(explicit.push).toMatchObject({ enqueue: "accepted", processing: "unconfirmed" });
  calls = readFileSync(envTo, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.filter((c) => c.args.includes("--message"))).toHaveLength(1);
  const terminal = runCodex("--host", "codex", "--test-push");
  expect(terminal.push.enqueue).toBe("no-session");
  expect(
    readFileSync(envTo, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((c) => c.args.includes("--message")),
  ).toHaveLength(1);
  // plan 22: a shell names the thread Codex does not export to it
  const thread = "01a0f53b-a47d-7350-83a4-c3430e4534ff";
  const named = runCodex("--host", "codex", "--test-push", "--thread", thread);
  expect(named.push).toMatchObject({ enqueue: "accepted", processing: "unconfirmed" });
  const sent = readFileSync(envTo, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((c) => c.args.includes("--message"));
  expect(sent).toHaveLength(2);
  expect(sent[1].args.slice(0, 5)).toEqual(["queue", "--remote", "unix://", "--thread", thread]);
}, 60_000);

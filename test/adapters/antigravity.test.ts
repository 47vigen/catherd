import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writableRoots } from "../../src/adapters/access.ts";
import {
  AGY_ACCESS,
  agyPrompt,
  agyShell,
  antigravityAdapter,
  ISOLATED_LISTING,
  isolatedAgyHome,
  isolatedAgyRoot,
} from "../../src/adapters/antigravity/index.ts";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { readDiscovery } from "../../src/adapters/discovery.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { configDir, dataDir } from "../../src/infra/paths.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { withAgyScenario, type AgyScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const SIM = join(import.meta.dir, "..", "sim", "agy");
/** The simulators, Bun and the system tools, and nothing of this machine's own: never a real agy. */
const SIMS = [dirname(SIM), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());
afterEach(() => {
  agyShell.timeoutMs = 30_000;
});
// a HOME of the test's own: the probe reads ~/.gemini's settings and the simulator reads HOME's, never the user's
beforeEach(() => {
  process.env.HOME = tempDir("catherd-agyhome-");
  delete process.env.GEMINI_API_KEY;
});

/** The simulator on PATH with scenario `s`; returns the scenario's handle. */
function sim(s: AgyScenario = {}) {
  process.env.PATH = SIMS;
  const x = withAgyScenario({ modelsFile: join(FX, "models.txt"), ...s });
  Object.assign(process.env, x.env);
  return x;
}

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("antigravity:gemini-3.8-flash#high"),
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
  exit: { code: 0, signal: null, reason: "exited", endedAt: "2026-09-29T00:00:00.000Z" },
  startedAtMs: 0,
  ...over,
});
const exit = (code: number | null, reason: "exited" | "cancelled" | "wall-timeout" = "exited") => ({
  exit: { code, signal: null, reason, endedAt: "x" },
});

async function code(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

const LOGIN_FIX =
  "run agy once to sign in with Google, or export GEMINI_API_KEY=<key> and catherd profile set harness.antigravity.isolated true";

describe("agy plan (spec 1.3 §6.2, §6.3)", () => {
  it("points -p at the brief file, prints stream-json, turns slash commands and auto-update off, stdin none", () => {
    process.env.PATH = SIMS;
    expect(antigravityAdapter.plan(req())).toEqual({
      cmd: "agy",
      args: [
        "-p",
        "Read the brief in /d/brief.md and follow it. Your final message is your reply.",
        "--output-format",
        "stream-json",
        "--model",
        "gemini-3.8-flash",
        "--effort",
        "high",
        "--disable-slash-commands",
        "--sandbox",
        "--dangerously-skip-permissions",
      ],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      cwd: "/repo",
      stdinPath: null,
    });
    expect(agyPrompt("/x/brief.md")).toBe(
      "Read the brief in /x/brief.md and follow it. Your final message is your reply.",
    );
  });

  it("maps each access, passes no --effort for #default, and resumes a conversation", () => {
    expect(AGY_ACCESS).toEqual({
      "read-only": [],
      "workspace-write": ["--sandbox", "--dangerously-skip-permissions"],
      full: ["--dangerously-skip-permissions"],
    });
    const thread = "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b";
    const p = antigravityAdapter.plan(
      req({ rung: parseRung("antigravity:gemini-3.8-flash#default"), thread }),
    );
    expect(p.args).not.toContain("--effort");
    expect(p.args).not.toContain("--print-timeout");
    expect(p.args.slice(-2)).toEqual(["--conversation", thread]);
  });

  it("isolates under catherd's own HOME per access, with catherd's dirs kept, and writes nothing to plan", () => {
    withHome();
    const env = antigravityAdapter.plan(req({ isolated: true })).env;
    const home = isolatedAgyHome("workspace-write", true);
    expect(home).toBe(join(isolatedAgyRoot(), "workspace-write"));
    expect(env).toMatchObject({
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      HOME: home,
      CATHERD_CONFIG_DIR: configDir(),
      CATHERD_DATA_DIR: dataDir(),
    });
    expect(antigravityAdapter.plan(req({ isolated: true, network: false })).env.HOME).toBe(
      join(isolatedAgyRoot(), "workspace-write-offline"),
    );
    expect(existsSync(isolatedAgyRoot())).toBe(false);
  });
});

describe("agy finalize (spec 1.3 §6.5)", () => {
  it("is ok only on a SUCCESS result, with its response as the reply, though the grace kill ended the CLI", () => {
    expect(antigravityAdapter.finalize(finished(lines("ok.jsonl")))).toMatchObject({
      status: "ok",
      thread: "3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c",
      reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      tokens: { input: 25717, cached: 9728, output: 335 },
      costUsd: null,
      error: null,
    });
    const killed = finished(lines("ok.jsonl"), {
      exit: { code: null, signal: "SIGTERM", reason: "exited", endedAt: "x" },
    });
    expect(antigravityAdapter.finalize(killed).status).toBe("ok");
  });

  it("gives the logged-out result the login fix, and keeps the request's thread", () => {
    const thread = "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b";
    const o = antigravityAdapter.finalize(
      finished(lines("logged-out.jsonl"), { request: req({ thread }), ...exit(1) }),
    );
    expect(o).toMatchObject({
      status: "failed",
      thread,
      error: { code: "failed", message: `authentication failed or timed out (fix: ${LOGIN_FIX})` },
    });
    expect(o.reply).toBeUndefined();
  });

  it("reads the AGY_ERROR line: a quota stop is a limit, any other error fails with its message", () => {
    const quota =
      'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-7f3a","message":"Weekly quota exhausted for Gemini 3.8 Flash."}\n';
    const at = (stderr: string) =>
      antigravityAdapter.finalize(finished(lines("error.jsonl"), { stderr, ...exit(3) }));
    expect(at(quota)).toMatchObject({
      status: "limit",
      error: { code: "limit", message: "Weekly quota exhausted for Gemini 3.8 Flash." },
    });
    expect(
      at('AGY_ERROR: {"status":"FAILED_PRECONDITION","message":"daily spend cap reached"}\n').status,
    ).toBe("limit");
    expect(at('AGY_ERROR: {"status":"INTERNAL","code":500,"message":"backend error"}\n')).toMatchObject({
      status: "failed",
      error: { message: "backend error" },
    });
    expect(at("").error?.message).toBe("model request failed");
  });

  it("reads exit 2 as a CLI too old, a partial print-timeout run as failed, and a cancel or timeout as such", () => {
    const old = antigravityAdapter.finalize(
      finished([], {
        stderr: "flags provided but not defined: -disable-slash-commands\nUsage of agy:\n  -p string\n",
        ...exit(2),
      }),
    );
    expect(old).toMatchObject({
      status: "cli-too-old",
      error: { message: "flags provided but not defined: -disable-slash-commands" },
    });
    const partial = antigravityAdapter.finalize(
      finished(lines("partial.jsonl"), { stderr: "warning: print timeout reached; output is partial\n" }),
    );
    expect(partial).toMatchObject({
      status: "failed",
      thread: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      error: { message: "warning: print timeout reached; output is partial" },
    });
    const canceled = lines("ok.jsonl").at(-1)?.replace('"SUCCESS"', '"CANCELED"') as string;
    expect(antigravityAdapter.finalize(finished([canceled], exit(1))).status).toBe("cancelled");
    expect(antigravityAdapter.finalize(finished([], exit(null, "cancelled"))).status).toBe("cancelled");
    expect(antigravityAdapter.finalize(finished([], exit(null, "wall-timeout"))).status).toBe("timeout");
    expect(antigravityAdapter.finalize(finished([], exit(1))).error?.message).toBe(
      "no result event (exited, exit 1)",
    );
  });
});

describe("agy parse (spec 1.3 §6.5)", () => {
  it("marks the result final with its tokens, and a limit in a failed result", () => {
    expect(antigravityAdapter.parse(lines("ok.jsonl").at(-1) as string)).toMatchObject({
      final: true,
      thread: "3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c",
      tokens: { input: 25717, cached: 9728, output: 335 },
      lastEvent: "result/SUCCESS",
    });
    const quota = JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exhausted" } });
    expect(antigravityAdapter.parse(quota)).toMatchObject({
      final: true,
      limit: true,
      failure: "quota exhausted",
    });
  });

  it("opens and closes an item per tool step, and reads each request's input from its usage", () => {
    const l = lines("ok.jsonl");
    expect(antigravityAdapter.parse(l[8] as string)).toMatchObject({
      item: { id: "step-4", open: true },
      activity: "$ bun test",
    });
    expect(antigravityAdapter.parse(l[9] as string)).toMatchObject({ item: { id: "step-4", open: false } });
    expect(antigravityAdapter.parse(l[2] as string)).toMatchObject({
      requestInput: 5200,
      activity: "I'll read the lane file.",
    });
    const init = antigravityAdapter.parse(l[0] as string);
    expect([init.item, init.final, init.thread]).toEqual([undefined, undefined, undefined]);
  });
});

describe("agy probe (spec 1.3 §6.1, §3.3)", () => {
  it("reads the version and a Google login that answers `agy models`, billed as a subscription", async () => {
    sim();
    expect(await antigravityAdapter.probe()).toEqual({
      installed: true,
      version: "1.2.13",
      versionOk: true,
      loggedIn: true,
      login: "Google",
      billing: "subscription",
      problems: [],
    });
  });

  it("reads the API key route of the user's own settings as metered", async () => {
    sim({ loggedIn: false });
    const dir = join(process.env.HOME as string, ".gemini", "antigravity-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), '{"modelProvider":"gemini"}');
    process.env.GEMINI_API_KEY = "key-for-test";
    expect(await antigravityAdapter.probe()).toMatchObject({
      loggedIn: true,
      login: "API key",
      billing: "metered",
    });
  });

  it("refuses a logged-out agy with the login fix, from `agy models` alone: never a run, never a browser", async () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const s = sim({ loggedIn: false, browserTo, version: "1.2.9" });
    const p = await antigravityAdapter.probe();
    expect(p).toMatchObject({ installed: true, version: "1.2.9", versionOk: false, loggedIn: false });
    expect(p.problems.map((x) => [x.code, x.message, x.fix])).toEqual([
      [
        "E_BACKEND_TOO_OLD",
        "agy 1.2.9 is older than 1.2.13",
        "brew upgrade --cask antigravity-cli, or run the install script again",
      ],
      ["E_BACKEND_NOT_LOGGED_IN", "agy is not signed in (agy models says: Please sign in)", LOGIN_FIX],
    ]);
    expect(existsSync(browserTo)).toBe(false);
    expect(s.ran()).toBe(false);
    // with GEMINI_API_KEY an isolated run can still go: no problem, and native runs are refused at prepare
    process.env.GEMINI_API_KEY = "key-for-test";
    expect((await antigravityAdapter.probe()).problems.map((x) => x.code)).toEqual(["E_BACKEND_TOO_OLD"]);
  });

  it("says agy is not on PATH, with the install command", async () => {
    process.env.PATH = "/nonexistent";
    expect((await antigravityAdapter.probe()).problems[0]).toEqual({
      code: "E_BACKEND_MISSING",
      message: "agy is not on PATH",
      fix: "curl -fsSL https://antigravity.google/cli/install.sh | bash (it installs ~/.local/bin/agy: put that dir on PATH), or brew install --cask antigravity-cli",
    });
  });
});

describe("agy models, prepare and quota (spec 1.3 §6.3, §6.4, §6.6)", () => {
  const prep = (
    rung: string,
    access: "read-only" | "workspace-write" | "full" = "workspace-write",
    isolated = false,
    network = true,
  ) => code(antigravityAdapter.prepare?.({ rung: parseRung(rung), access, isolated, repo: "/r", network }));

  it("lists models from `agy models`, and refuses a model or effort agy does not list, before anything runs", async () => {
    withHome();
    sim();
    expect((await antigravityAdapter.listModels()).find((m) => m.id === "gemini-3.1-pro")?.efforts).toEqual([
      "low",
      "high",
    ]);
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("ok");
    expect(await prep("antigravity:gemini-3.8-flash#low")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("antigravity:gemini-3.7-flash#max")).toBe("ok");
    expect(await prep("antigravity:gemini-9#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(readDiscovery("antigravity")?.models.length).toBe(6);
  });

  it("refuses a read-only role on native agy, which has no read-only mode (spec 1.3 §9 Q2)", async () => {
    withHome();
    sim();
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high", "read-only")).toBe("E_ADMIT_RUNG");
    expect(await prep("antigravity:gemini-3.8-flash#high", "full")).toBe("ok");
  });

  it("refuses a native run when `agy models` failed some other way: it cannot confirm the login (review, PR #32)", async () => {
    withHome();
    sim({ modelsExit: 1 });
    expect((await antigravityAdapter.probe()).loggedIn).toBeNull();
    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("E_BACKEND_NOT_LOGGED_IN");
  });

  it("refuses a native run once the probe found agy logged out: it would open a browser", async () => {
    withHome();
    sim({ loggedIn: false });
    process.env.GEMINI_API_KEY = "key-for-test";
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("E_BACKEND_NOT_LOGGED_IN");
    // isolated, the key signs it in
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe("ok");
  });

  it("checks an isolated rung against the key's own listing, cached apart from the login's (1.3 follow-ups)", async () => {
    withHome();
    const keyModelsFile = join(tempDir("catherd-agy-key-"), "models.txt");
    writeFileSync(keyModelsFile, "\nAvailable models:\n  * gemini-3.7-flash (default)\n");
    sim({ keyModelsFile });
    process.env.GEMINI_API_KEY = "key-for-test";
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("ok");
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe(
      "E_BACKEND_MODEL_UNKNOWN",
    );
    expect(await prep("antigravity:gemini-3.7-flash#max", "workspace-write", true)).toBe("ok");
    expect(readDiscovery("antigravity")?.models.length).toBe(6);
    expect(readDiscovery(ISOLATED_LISTING)?.models.map((m) => m.id)).toEqual(["gemini-3.7-flash"]);
  });

  it("needs GEMINI_API_KEY to isolate, and writes each isolated home's settings: the provider and the access rules", async () => {
    withHome();
    sim();
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe(
      "E_BACKEND_NOT_LOGGED_IN",
    );
    expect(existsSync(isolatedAgyRoot())).toBe(false);
    process.env.GEMINI_API_KEY = "key-for-test";
    const settings = (access: "read-only" | "workspace-write" | "full", network = true) =>
      JSON.parse(
        readFileSync(
          join(isolatedAgyHome(access, network), ".gemini", "antigravity-cli", "settings.json"),
          "utf8",
        ),
      );
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe("ok");
    expect(settings("workspace-write")).toEqual({
      modelProvider: "gemini",
      permissions: { allow: [...writableRoots().map((r) => `write_file(${r})`), "read_url(*)"] },
    });
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true, false)).toBe("ok");
    expect(settings("workspace-write", false).permissions.allow).not.toContain("read_url(*)");
    expect(await prep("antigravity:gemini-3.8-flash#high", "read-only", true)).toBe("ok");
    expect(settings("read-only")).toEqual({
      modelProvider: "gemini",
      permissions: { deny: ["write_file(*)", "command(*)"] },
    });
    expect(await prep("antigravity:gemini-3.8-flash#high", "full", true)).toBe("ok");
    expect(settings("full")).toEqual({ modelProvider: "gemini" });
  });

  it("reads the quota through `/usage` without a turn, and nothing when agy cannot say", async () => {
    const usageTo = join(tempDir("catherd-usage-"), "args");
    sim({ usageTo });
    expect(await antigravityAdapter.quota?.()).toBe("Weekly quota: 62% left, resets Monday 09:00");
    expect(JSON.parse(readFileSync(usageTo, "utf8").trim())).toEqual([
      "-p",
      "/usage",
      "--output-format",
      "json",
    ]);
    sim({ usageExit: 1 });
    expect(await antigravityAdapter.quota?.()).toBeNull();
  });
});

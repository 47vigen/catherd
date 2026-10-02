import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { readDiscovery } from "../../src/adapters/discovery.ts";
import { grokHost, READ_TOOLS } from "../../src/adapters/grok/home.ts";
import {
  GROK_INSTALL,
  grokAdapter,
  grokShell,
  ISOLATED_LISTING,
  isolatedGrokRoot,
  sessionFor,
} from "../../src/adapters/grok/index.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { withGrokScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "grok");
const SIM = join(import.meta.dir, "..", "sim", "grok");
/** The simulators, Bun and the system tools, and nothing of this machine's own grok. */
const SIMS = [dirname(SIM), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const SESSION = "3c9a2f1e-7b4d-4e8a-9f60-1d2c3b4a5e6f";
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());
const host = { ...grokHost };
afterEach(() => {
  Object.assign(grokHost, host);
  grokShell.timeoutMs = 15_000;
});

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("grok:grok-4.6#high"),
  access: "workspace-write",
  thread: null,
  isolated: false,
  repo: "/repo",
  briefPath: "/d/brief.md",
  replyPath: "/d/reply.md",
  dispatchDir: "/d",
  ...over,
});

const exit = (code: number | null, reason: "exited" | "cancelled" | "wall-timeout" = "exited") => ({
  code,
  signal: null,
  reason,
  endedAt: "2026-09-29T00:00:00.000Z",
});

const finished = (eventLines: string[], over: Partial<FinishedRun> = {}): FinishedRun => ({
  request: req(),
  eventLines,
  reply: "",
  stderr: "",
  exit: exit(0),
  startedAtMs: 0,
  ...over,
});

async function code(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

/** A Mac whose docker socket is a symlink (Docker Desktop, OrbStack), or a Linux host. */
function onHost(kind: "mac-symlinked-socket" | "linux"): void {
  if (kind === "linux") {
    grokHost.platform = "linux";
    return;
  }
  const dir = tempDir("catherd-sock-");
  writeFileSync(join(dir, "real.sock"), "");
  symlinkSync(join(dir, "real.sock"), join(dir, "docker.sock"));
  Object.assign(grokHost, { platform: "darwin", dockerSocket: join(dir, "docker.sock") });
}

describe("grok plan (spec 1.3 §5.2, §5.3)", () => {
  it("passes the brief by file, the repo, model and effort, the hidden flags, catherd-ws and a fresh session", () => {
    const p = grokAdapter.plan(req());
    const session = p.args.at(-1) as string;
    expect(grokAdapter.resume.threadPattern.test(session)).toBe(true);
    expect(p).toEqual({
      cmd: "grok",
      args: [
        "--prompt-file",
        "/d/brief.md",
        "--output-format",
        "streaming-json",
        "--cwd",
        "/repo",
        "-m",
        "grok-4.6",
        "--effort",
        "high",
        "--always-approve",
        "--trust",
        "--no-auto-update",
        "--no-memory",
        "--sandbox",
        "catherd-ws",
        "-s",
        session,
      ],
      env: { GROK_DISABLE_AUTOUPDATER: "1" },
      cwd: "/repo",
      stdinPath: null,
    });
    // one id per dispatch, known without the stream: finalize records it for a run grok never ended
    expect(grokAdapter.plan(req()).args.at(-1)).toBe(session);
    expect(grokAdapter.plan(req({ dispatchDir: "/d2" })).args.at(-1)).not.toBe(session);
  });

  it("maps each access, runs #default with no --effort, and resumes with -r and no --sandbox", () => {
    onHost("linux");
    const sandbox = (over: Partial<RunRequest>) => {
      const a = grokAdapter.plan(req(over)).args;
      return a.includes("--sandbox") ? a[a.indexOf("--sandbox") + 1] : null;
    };
    expect(sandbox({ access: "read-only" })).toBe("read-only");
    expect(sandbox({ access: "full" })).toBe("off");
    expect(sandbox({ network: false })).toBe("catherd-ws-offline");
    const a = grokAdapter.plan(req({ thread: SESSION, rung: parseRung("grok:grok-4.6#default") })).args;
    expect(a.slice(-2)).toEqual(["-r", SESSION]);
    for (const flag of ["--sandbox", "-s", "--effort", "--tools"]) expect(a).not.toContain(flag);
  });

  it("runs read-only with the read tools only where the kernel profile refuses, and keeps them on resume", () => {
    onHost("mac-symlinked-socket");
    const fresh = grokAdapter.plan(req({ access: "read-only" })).args;
    expect(fresh.slice(-6, -2)).toEqual(["--sandbox", "workspace", "--tools", READ_TOOLS]);
    const resumed = grokAdapter.plan(req({ access: "read-only", thread: SESSION })).args;
    expect(resumed.slice(-4)).toEqual(["--tools", READ_TOOLS, "-r", SESSION]);
    expect(resumed).not.toContain("--sandbox");
    expect(grokAdapter.enforcement["read-only"]).toBe("advisory");
    onHost("linux");
    expect(grokAdapter.enforcement).toEqual({
      "read-only": "enforced",
      "workspace-write": "enforced",
      full: "enforced",
    });
  });

  it("isolates in catherd's HOME and GROK_HOME, with the toggles and memory off, and writes nothing", () => {
    withHome();
    const env = grokAdapter.plan(req({ isolated: true })).env;
    expect(env).toMatchObject({
      GROK_DISABLE_AUTOUPDATER: "1",
      HOME: isolatedGrokRoot(),
      GROK_HOME: join(isolatedGrokRoot(), ".grok"),
      GROK_MEMORY: "0",
      GROK_CURSOR_RULES_ENABLED: "0",
    });
    expect(existsSync(isolatedGrokRoot())).toBe(false);
  });
});

describe("grok finalize (spec 1.3 §5.5)", () => {
  it("is ok on end_turn, whatever the exit, with the final message, the tokens and the reported cost", () => {
    for (const e of [exit(0), { ...exit(null), signal: "SIGTERM" as const }])
      expect(grokAdapter.finalize(finished(lines("ok.jsonl"), { exit: e }))).toMatchObject({
        status: "ok",
        thread: SESSION,
        costUsd: 0.0127,
        reply: "Done.\nSTATUS: complete — wrote src/a.ts",
        error: null,
      });
    expect(grokAdapter.finalize(finished(lines("login-ok.jsonl"))).costUsd).toBeNull();
  });

  it("names why a run stopped short, and gives a missing login its fix", () => {
    const max = grokAdapter.finalize(finished(lines("max-turns.jsonl"), { exit: exit(0) }));
    expect([max.status, max.error]).toEqual([
      "failed",
      { code: "failed", message: "stopped: max_turn_requests" },
    ]);
    const out = grokAdapter.finalize(
      finished(lines("not-signed-in.jsonl"), { request: req({ thread: SESSION }), exit: exit(1) }),
    );
    expect(out).toMatchObject({
      status: "failed",
      thread: SESSION,
      error: {
        code: "failed",
        message:
          "grok is not signed in (fix: grok login, or grok login --device-code without a browser, or export XAI_API_KEY=<key>)",
      },
    });
    expect(out.reply).toBeUndefined();
    const none = grokAdapter.finalize(finished(lines("no-end.jsonl"), { exit: exit(1) }));
    expect(none).toMatchObject({
      status: "failed",
      tokens: { input: 23100, cached: 20000, output: 900 },
      error: { message: "no end event (exited, exit 1)" },
    });
  });

  it("reads a limit, no subscription, a CLI too old, a cancel and a timeout as such", () => {
    const at = (fixture: string, over: Partial<FinishedRun> = {}) =>
      grokAdapter.finalize(finished(lines(fixture), { exit: exit(1), ...over }));
    expect(at("rate-limit.jsonl").status).toBe("limit");
    expect(at("free-limit.jsonl").status).toBe("limit");
    expect(at("subscription.jsonl").status).toBe("failed");
    const old = at("empty.jsonl", {
      exit: exit(2),
      stderr: "error: unexpected argument '--no-memory' found\n\nUsage: grok [OPTIONS]\n",
    });
    expect([old.status, old.error?.message]).toEqual([
      "cli-too-old",
      "error: unexpected argument '--no-memory' found",
    ]);
    expect(at("no-end.jsonl", { exit: exit(null, "cancelled") }).status).toBe("cancelled");
    expect(at("no-end.jsonl", { exit: exit(null, "wall-timeout") }).status).toBe("timeout");
  });
});

describe("grok parse (spec 1.3 §5.5)", () => {
  it("gives each response's input, marks end final with its tokens, thread and cost, and an error final", () => {
    const ok = lines("ok.jsonl");
    expect(grokAdapter.parse(ok[5] as string)).toMatchObject({ lastEvent: "usage", requestInput: 23100 });
    expect(grokAdapter.parse(ok.at(-1) as string)).toMatchObject({
      final: true,
      thread: SESSION,
      tokens: { input: 48210, cached: 41000, output: 1893 },
      costUsd: 0.0127,
    });
    expect(grokAdapter.parse(lines("max-turns.jsonl")[2] as string)).toMatchObject({
      final: true,
      failure: "stopped: max_turn_requests",
    });
    expect(grokAdapter.parse(lines("rate-limit.jsonl")[0] as string)).toMatchObject({
      final: true,
      limit: true,
    });
    expect(grokAdapter.parse(lines("subscription.jsonl")[0] as string).limit).toBeUndefined();
  });

  it("reports a tool call opening and closing, and what the worker is doing", () => {
    const ok = lines("ok.jsonl");
    expect(grokAdapter.parse(ok[8] as string)).toMatchObject({
      item: { id: "call_3", open: true },
      activity: "$ bun test",
    });
    expect(grokAdapter.parse(ok[9] as string)).toMatchObject({ item: { id: "call_3", open: false } });
    const thought = grokAdapter.parse(ok[1] as string);
    expect([thought.item, thought.activity, thought.final]).toEqual([undefined, undefined, undefined]);
  });
});

describe("grok probe (spec 1.3 §5.1, §5.6, §3.3)", () => {
  it("reads the version, a Grok login from grok models' first line, and whether read-only applies here", async () => {
    process.env.PATH = SIMS;
    onHost("linux");
    process.env.XAI_API_KEY = "key-for-test";
    const s = withGrokScenario({});
    Object.assign(process.env, s.env);
    expect(await grokAdapter.probe()).toEqual({
      installed: true,
      version: "1.0.44",
      versionOk: true,
      loggedIn: true,
      login: "Grok",
      billing: "subscription",
      problems: [],
      info: [
        {
          id: "sandbox:grok",
          label: "grok sandbox",
          detail: "grok's read-only profile applies here; catherd runs a read-only role in it (enforced)",
        },
      ],
    });
    // a login and a key here, yet the check runs from an empty GROK_HOME with no key: it stops at the login
    // and spends no turn
    expect(s.ran()).toBe(false);
    Object.assign(process.env, withGrokScenario({ loggedIn: false }).env, { XAI_API_KEY: "key-for-test" });
    expect(await grokAdapter.probe()).toMatchObject({ loggedIn: true, login: "API key", billing: "metered" });
  });

  it("says when grok refuses its read-only profile here, from a run that spends no turn", async () => {
    process.env.PATH = SIMS;
    onHost("mac-symlinked-socket");
    Object.assign(process.env, withGrokScenario({ socketSymlink: true }).env);
    const refused =
      "grok refuses its read-only profile here (sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink)";
    expect((await grokAdapter.probe()).info?.[0]?.detail).toBe(
      `${refused}; catherd runs a read-only role in the workspace profile with the read tools only (advisory)`,
    );
    // a refusal catherd does not predict (another socket, a Linux without Landlock): the role would fail
    onHost("linux");
    expect((await grokAdapter.probe()).info?.[0]?.detail).toBe(
      `${refused}; a read-only grok role fails here: give it another backend or full access`,
    );
  });

  it("reports a CLI too old, not logged in, or missing, each with its fix", async () => {
    process.env.PATH = SIMS;
    delete process.env.XAI_API_KEY;
    Object.assign(process.env, withGrokScenario({ version: "1.0.41", loggedIn: false }).env);
    const p = await grokAdapter.probe();
    expect(p).toMatchObject({ installed: true, version: "1.0.41", versionOk: false, loggedIn: false });
    expect(p.problems.map((x) => [x.code, x.message, x.fix])).toEqual([
      ["E_BACKEND_TOO_OLD", "grok 1.0.41 is older than 1.0.44", "grok update --stable"],
      [
        "E_BACKEND_NOT_LOGGED_IN",
        "grok is not logged in (grok models says: You are not authenticated.)",
        "grok login, or grok login --device-code without a browser, or export XAI_API_KEY=<key>",
      ],
    ]);
    process.env.PATH = "/nonexistent";
    expect((await grokAdapter.probe()).problems[0]).toMatchObject({
      code: "E_BACKEND_MISSING",
      fix: GROK_INSTALL,
    });
    expect(grokAdapter.install).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
  });
});

describe("grok identities (1.3 follow-ups)", () => {
  it("derives a run's session from its dispatch id alone, wherever the data dir resolves", () => {
    const id = "20261002-101500-ab12cd";
    const a = sessionFor({ dispatchDir: `/var/data/runs/r/roles/worker-M1.L1/${id}` });
    expect(sessionFor({ dispatchDir: `/private/var/data/runs/r/roles/worker-M1.L1/${id}` })).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionFor({ dispatchDir: "/var/data/runs/r/roles/worker-M1.L1/other" })).not.toBe(a);
  });

  it("runs doctor's sandbox check in a scratch HOME, memory and the compat features off, with no key", async () => {
    withHome();
    process.env.PATH = SIMS;
    onHost("linux");
    process.env.XAI_API_KEY = "key-for-test";
    const callsTo = join(tempDir("catherd-grok-calls-"), "calls.jsonl");
    Object.assign(process.env, withGrokScenario({ callsTo }).env);
    await grokAdapter.probe();
    const calls = readFileSync(callsTo, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; home: string; vars: Record<string, string> });
    const check = calls.find((c) => c.args.includes("--sandbox"));
    if (!check) throw new Error("no sandbox check ran");
    expect(check.home).not.toBe(process.env.HOME);
    expect(check.vars.GROK_HOME).toBe(join(check.home, ".grok"));
    expect(check.vars).toMatchObject({
      GROK_MEMORY: "0",
      GROK_CLAUDE_HOOKS_ENABLED: "0",
      GROK_CURSOR_RULES_ENABLED: "0",
      XAI_API_KEY: "",
    });
  });

  it("checks an isolated rung against the key's own listing, cached apart from the login's", async () => {
    withHome();
    process.env.PATH = SIMS;
    process.env.GROK_HOME = tempDir("catherd-grokhome-"); // the user's, signed in with a Grok login
    process.env.XAI_API_KEY = "key-for-test";
    Object.assign(
      process.env,
      withGrokScenario({ models: ["grok-4.6", "grok-4.5"], keyModels: ["grok-4.5"] }).env,
    );
    const prep = (isolated: boolean, rung = "grok:grok-4.6#high") =>
      code(grokAdapter.prepare?.({ rung: parseRung(rung), access: "read-only", isolated, repo: "/r" }));
    expect(await prep(false)).toBe("ok");
    expect(await prep(true)).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep(true, "grok:grok-4.5#high")).toBe("ok");
    expect(readDiscovery("grok")?.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(readDiscovery(ISOLATED_LISTING)?.models.map((m) => m.id)).toEqual(["grok-4.5"]);
  });
});

describe("grok models and prepare (spec 1.3 §5.2, §5.3, §5.6)", () => {
  it("lists grok's models with the catalog's efforts and context", async () => {
    process.env.PATH = SIMS;
    Object.assign(process.env, withGrokScenario({ models: ["grok-4.6", "grok-build-0.1"] }).env);
    expect(await grokAdapter.listModels()).toEqual([
      { id: "grok-4.6", efforts: ["low", "medium", "high", "xhigh"], context: 500_000, imageIn: false },
      { id: "grok-build-0.1", efforts: [], context: null, imageIn: false },
    ]);
  });

  it("refuses a model grok does not list and an effort the catalog does not offer, and caches the listing", async () => {
    withHome();
    process.env.PATH = SIMS;
    process.env.GROK_HOME = tempDir("catherd-grokhome-");
    Object.assign(process.env, withGrokScenario({}).env);
    const prep = (rung: string) =>
      code(
        grokAdapter.prepare?.({ rung: parseRung(rung), access: "read-only", isolated: false, repo: "/r" }),
      );
    expect(await prep("grok:grok-4.6#xhigh")).toBe("ok");
    expect(await prep("grok:grok-4.6#default")).toBe("ok");
    expect(await prep("grok:grok-4.6#max")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("grok:grok-9#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(readDiscovery("grok")?.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(existsSync(join(process.env.GROK_HOME, "sandbox.toml"))).toBe(false); // read-only needs no table
  });

  it("writes catherd-ws into the user's GROK_HOME for a native workspace-write run", async () => {
    withHome();
    process.env.PATH = SIMS;
    const home = tempDir("catherd-grokhome-");
    process.env.GROK_HOME = home;
    writeFileSync(join(home, "sandbox.toml"), '[profiles.dev]\nextends = "devbox"\n');
    Object.assign(process.env, withGrokScenario({}).env);
    const r = grokAdapter.prepare?.({
      rung: parseRung("grok:grok-4.6#high"),
      access: "workspace-write",
      isolated: false,
      repo: "/r",
    });
    expect(await code(r)).toBe("ok");
    const toml = Bun.TOML.parse(readFileSync(join(home, "sandbox.toml"), "utf8")) as { profiles: object };
    expect(Object.keys(toml.profiles)).toEqual(["dev", "catherd-ws", "catherd-ws-offline"]);
  });

  it("needs XAI_API_KEY to isolate, and writes catherd-ws in catherd's own GROK_HOME", async () => {
    withHome();
    process.env.PATH = SIMS;
    process.env.GROK_HOME = tempDir("catherd-grokhome-"); // the user's: untouched by an isolated run
    Object.assign(process.env, withGrokScenario({}).env);
    delete process.env.XAI_API_KEY;
    const prep = () =>
      code(
        grokAdapter.prepare?.({
          rung: parseRung("grok:grok-4.6#high"),
          access: "workspace-write",
          isolated: true,
          repo: "/r",
        }),
      );
    expect(await prep()).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(existsSync(isolatedGrokRoot())).toBe(false);
    process.env.XAI_API_KEY = "key-for-test";
    expect(await prep()).toBe("ok");
    expect(readFileSync(join(isolatedGrokRoot(), ".grok", "sandbox.toml"), "utf8")).toContain(
      "[profiles.catherd-ws]",
    );
    expect(existsSync(join(process.env.GROK_HOME, "sandbox.toml"))).toBe(false);
  });
});

describe("grok thread of a run that never ended (plan 16 final review, Important 2)", () => {
  it("keeps catherd's -s session id after a timeout, and records none when grok never started a session", () => {
    const session = grokAdapter.plan(req()).args.at(-1) as string;
    const timedOut = grokAdapter.finalize(
      finished(lines("no-end.jsonl"), { exit: exit(null, "wall-timeout") }),
    );
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.thread).toBe(session);
    const loggedOut = grokAdapter.finalize(finished(lines("not-signed-in.jsonl"), { exit: exit(1) }));
    expect(loggedOut.thread).toBeNull();
  });
});

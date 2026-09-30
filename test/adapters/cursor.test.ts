import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scratchShell, writableRoots } from "../../src/adapters/access.ts";
import type { AccessShell, FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import {
  CURSOR_ACCESS,
  cursorAdapter,
  cursorBin,
  cursorShell,
  isolatedCursorHome,
  isolatedCursorRoot,
} from "../../src/adapters/cursor/index.ts";
import { ensureLink } from "../../src/adapters/cursor/home.ts";
import { readDiscovery } from "../../src/adapters/discovery.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { configDir, dataDir } from "../../src/infra/paths.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { withCursorScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const SIM = join(import.meta.dir, "..", "sim", "cursor-agent");
/** The simulators, Bun and the system tools, and nothing of this machine's own: its `agent` may be anyone's. */
const SIMS = [dirname(SIM), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());
afterEach(() => {
  cursorShell.timeoutMs = 15_000;
});

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("cursor:gpt-6-sol#high"),
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

async function code(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

/** A PATH holding `name` (a link to the simulator, or a script), the simulators and Bun, for the shebangs. */
function pathWith(name: string, target: string | null, script?: string, sims = false): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  if (target) symlinkSync(target, join(dir, name));
  else {
    writeFileSync(join(dir, name), script ?? "");
    chmodSync(join(dir, name), 0o755);
  }
  return [dir, ...(sims ? [dirname(SIM)] : []), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
}

const ANOTHER_AGENT = "#!/bin/sh\necho 'agent 1.0.44 (grok)'\n";

describe("cursor plan (spec 1.3 §4.2, §4.3)", () => {
  it("prints stream-json in the trusted repo, with the effort's slug, auto-update off and the brief on stdin", () => {
    process.env.PATH = SIMS;
    expect(cursorAdapter.plan(req())).toEqual({
      cmd: "cursor-agent",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--trust",
        "--workspace",
        "/repo",
        "--model",
        "gpt-6-sol-high",
        "--disable-auto-update",
        "--sandbox",
        "enabled",
      ],
      env: { NO_OPEN_BROWSER: "1" },
      cwd: "/repo",
      stdinPath: "/d/brief.md",
    });
  });

  it("maps each access, never --force inside the sandbox, runs #default as the bare slug and resumes a chat", () => {
    expect(CURSOR_ACCESS).toEqual({
      "read-only": ["--mode", "ask", "--sandbox", "enabled"],
      "workspace-write": ["--sandbox", "enabled"],
      full: ["--force", "--sandbox", "disabled", "--approve-mcps"],
    });
    for (const access of ["read-only", "workspace-write"] as const)
      expect(cursorAdapter.plan(req({ access })).args).not.toContain("--force");
    const thread = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";
    const p = cursorAdapter.plan(req({ rung: parseRung("cursor:composer-2.5#default"), thread }));
    expect(p.args[p.args.indexOf("--model") + 1]).toBe("composer-2.5");
    expect(p.args.slice(-2)).toEqual(["--resume", thread]);
  });

  it("isolates with catherd's own HOME per access, Cursor's dirs inside it, and catherd's dirs kept", () => {
    withHome();
    const env = cursorAdapter.plan(req({ isolated: true })).env;
    const home = isolatedCursorHome("workspace-write", true);
    expect(home).toBe(join(isolatedCursorRoot(), "workspace-write"));
    expect(env).toMatchObject({
      NO_OPEN_BROWSER: "1",
      HOME: home,
      CURSOR_CONFIG_DIR: join(home, ".cursor"),
      CURSOR_DATA_DIR: join(home, ".cursor"),
      CATHERD_CONFIG_DIR: configDir(),
      CATHERD_DATA_DIR: dataDir(),
    });
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("memory"); // no keychain save under the moved HOME
    expect(cursorAdapter.plan(req()).env).not.toHaveProperty("AGENT_CLI_CREDENTIAL_STORE");
    expect(cursorAdapter.plan(req({ isolated: true, network: false })).env.HOME).toBe(
      join(isolatedCursorRoot(), "workspace-write-offline"),
    );
    expect(cursorAdapter.plan(req({ isolated: true, access: "read-only" })).env.HOME).toBe(
      join(isolatedCursorRoot(), "read-only"),
    );
    expect(existsSync(isolatedCursorRoot())).toBe(false); // plan writes nothing; prepare makes it
  });

  it("falls back to `agent` only when there is no cursor-agent on PATH", () => {
    process.env.PATH = pathWith("agent", SIM);
    expect(cursorBin()).toBe("agent");
    expect(cursorAdapter.plan(req()).cmd).toBe("agent");
  });
});

describe("cursor finalize (spec 1.3 §4.5)", () => {
  it("records the text after the last tool call as the reply, never the run-together result text", () => {
    const o = cursorAdapter.finalize(finished(lines("ok.jsonl")));
    expect(o).toMatchObject({
      status: "ok",
      reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      costUsd: null,
    });
  });

  it("is ok once a result arrived, though catherd killed the lingering CLI after it", () => {
    const o = cursorAdapter.finalize(
      finished(lines("ok.jsonl"), {
        exit: { code: null, signal: "SIGTERM", reason: "exited", endedAt: "x" },
      }),
    );
    expect(o.status).toBe("ok");
  });

  it("says why a run with no result failed, keeps the request's thread, and gives a missing login its fix", () => {
    const thread = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";
    const auth = cursorAdapter.finalize(
      finished([], {
        request: req({ thread }),
        stderr:
          "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
        exit: { code: 1, signal: null, reason: "exited", endedAt: "x" },
      }),
    );
    expect(auth).toMatchObject({
      status: "failed",
      thread,
      error: {
        code: "failed",
        message:
          "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable. (fix: cursor-agent login, or export CURSOR_API_KEY=<key>)",
      },
    });
    expect(auth.reply).toBeUndefined();
    const none = cursorAdapter.finalize(
      finished(lines("no-result.jsonl"), { exit: { code: 1, signal: null, reason: "exited", endedAt: "x" } }),
    );
    expect(none.error?.message).toBe("no result event (exited, exit 1)");
  });

  it("reads a limit, a team policy, a too-old client, a cancel and a timeout as such", () => {
    const at = (stderr: string, reason: "exited" | "cancelled" | "idle-timeout" = "exited") =>
      cursorAdapter.finalize(
        finished(lines("no-result.jsonl"), { stderr, exit: { code: 1, signal: null, reason, endedAt: "x" } }),
      ).status;
    expect(at("ActionRequiredError: FREE_USER_USAGE_LIMIT")).toBe("limit");
    expect(at("Error: Your team administrator has disabled the 'Run Everything' option.")).toBe("failed");
    expect(at("ActionRequiredError: OUTDATED_CLIENT")).toBe("cli-too-old");
    expect(at("", "cancelled")).toBe("cancelled");
    expect(at("", "idle-timeout")).toBe("timeout");
  });
});

describe("cursor parse (spec 1.3 §4.5)", () => {
  it("marks the result final with its tokens, and a limit in a failed result", () => {
    expect(cursorAdapter.parse(lines("ok.jsonl").at(-1) as string)).toMatchObject({
      final: true,
      thread: "2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21",
      tokens: { input: 15989, cached: 9728, output: 25 },
    });
    expect(
      cursorAdapter.parse(
        JSON.stringify({ type: "result", is_error: true, result: "You've hit your usage limit" }),
      ),
    ).toMatchObject({ final: true, limit: true, failure: "You've hit your usage limit" });
  });

  it("reports tool calls opening and closing, a retry, and what the worker is doing", () => {
    const l = lines("ok.jsonl");
    expect(cursorAdapter.parse(l[10] as string)).toMatchObject({
      item: { id: "toolu_03", open: true },
      activity: "$ bun test",
    });
    expect(cursorAdapter.parse(l[11] as string)).toMatchObject({ item: { id: "toolu_03", open: false } });
    expect(cursorAdapter.parse(l[8] as string)).toMatchObject({
      retrying: true,
      lastEvent: "retry/starting",
    });
    const thinking = cursorAdapter.parse(l[2] as string);
    expect([thinking.item, thinking.activity, thinking.final]).toEqual([undefined, undefined, undefined]);
  });
});

describe("cursor probe (spec 1.3 §4.1, §3.3)", () => {
  it("reads the version and a login that answers `models`, without a browser", async () => {
    process.env.PATH = SIMS;
    delete process.env.CURSOR_API_KEY;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    expect(await cursorAdapter.probe()).toEqual({
      installed: true,
      version: "2026.09.28",
      versionOk: true,
      loggedIn: true,
      login: "Cursor",
      problems: [],
    });
    process.env.CURSOR_API_KEY = "key-for-test";
    expect(await cursorAdapter.probe()).toMatchObject({ login: "API key", billing: "metered" });
  });

  it("reports a CLI too old, and one whose server calls say it is logged out, each with its fix", async () => {
    process.env.PATH = SIMS;
    delete process.env.CURSOR_API_KEY;
    Object.assign(process.env, withCursorScenario({ version: "2026.06.04-5fd875e", loggedIn: false }).env);
    const p = await cursorAdapter.probe();
    expect(p).toMatchObject({ installed: true, version: "2026.06.04", versionOk: false, loggedIn: false });
    expect(p.problems.map((x) => [x.code, x.message, x.fix])).toEqual([
      ["E_BACKEND_TOO_OLD", "cursor-agent 2026.06.04 is older than 2026.09.28", "cursor-agent update"],
      [
        "E_BACKEND_NOT_LOGGED_IN",
        "cursor-agent is not logged in (a server call says: Authentication required)",
        "cursor-agent login, or export CURSOR_API_KEY=<key>",
      ],
    ]);
  });

  it("does not take another program named agent for Cursor's CLI, and says so when both are there", async () => {
    process.env.PATH = pathWith("agent", null, ANOTHER_AGENT);
    const p = await cursorAdapter.probe();
    expect(p.installed).toBe(false);
    expect(p.problems[0]).toMatchObject({
      code: "E_BACKEND_MISSING",
      message: "the agent on PATH is not Cursor's CLI (it says: agent 1.0.44 (grok))",
      fix: "curl https://cursor.com/install -fsS | bash",
    });
    process.env.PATH = "/nonexistent";
    expect((await cursorAdapter.probe()).problems[0]?.message).toBe("cursor-agent is not on PATH");
    // cursor-agent is Cursor, `agent` another program: an info line, nothing to fix, and `agent` never runs
    process.env.PATH = pathWith("agent", null, "#!/bin/sh\nexit 99\n", true);
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    const other = realpathSync(Bun.which("agent", { PATH: process.env.PATH }) as string);
    const both = await cursorAdapter.probe();
    expect(both.problems).toEqual([]);
    expect(both.info).toEqual([
      {
        id: "name:agent",
        label: "agent",
        detail: `the agent on PATH (${other}) is another program than cursor-agent; catherd runs cursor-agent`,
      },
    ]);
    // the installer links both names to one binary: nothing to say
    process.env.PATH = pathWith("agent", SIM, undefined, true);
    expect((await cursorAdapter.probe()).info).toBeUndefined();
  });
});

describe("cursor models and prepare (spec 1.3 §4.6, §4.4)", () => {
  it("lists models from `models`, efforts folded", async () => {
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    const models = await cursorAdapter.listModels();
    expect(models.find((m) => m.id === "gpt-6-sol")?.efforts).toEqual(["default", "low", "high", "xhigh"]);
  });

  it("refuses a slug Cursor does not list, before anything runs, and caches the listing", async () => {
    withHome();
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    const prep = (rung: string) =>
      code(
        cursorAdapter.prepare?.({
          rung: parseRung(rung),
          access: "workspace-write",
          isolated: false,
          repo: "/r",
        }),
      );
    expect(await prep("cursor:gpt-6-sol#xhigh")).toBe("ok");
    expect(await prep("cursor:gpt-6-sol#medium")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("cursor:gpt-6-luna#default")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("cursor:gpt-9#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(readDiscovery("cursor")?.models.length).toBe(8);
  });

  it("lets a rung through when Cursor lists nothing", async () => {
    withHome();
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsExit: 1 }).env);
    const r = cursorAdapter.prepare?.({
      rung: parseRung("cursor:gpt-9#high"),
      access: "read-only",
      isolated: false,
      repo: "/r",
    });
    expect(await code(r)).toBe("ok");
  });

  it("needs CURSOR_API_KEY to isolate, and writes each isolated home's sandbox.json with a shared chats dir", async () => {
    withHome();
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    delete process.env.CURSOR_API_KEY;
    const prep = (access: "read-only" | "workspace-write" | "full", network = true) =>
      code(
        cursorAdapter.prepare?.({
          rung: parseRung("cursor:gpt-6-sol#high"),
          access,
          isolated: true,
          repo: "/r",
          network,
        }),
      );
    expect(await prep("workspace-write")).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(existsSync(isolatedCursorRoot())).toBe(false);
    process.env.CURSOR_API_KEY = "key-for-test";
    const policy = (access: "read-only" | "workspace-write", network = true) =>
      JSON.parse(readFileSync(join(isolatedCursorHome(access, network), ".cursor", "sandbox.json"), "utf8"));
    expect(await prep("workspace-write")).toBe("ok");
    expect(policy("workspace-write")).toEqual({
      type: "workspace_readwrite",
      additionalReadwritePaths: writableRoots(),
      networkPolicy: { default: "allow" },
    });
    expect(await prep("workspace-write", false)).toBe("ok");
    expect(policy("workspace-write", false)).toEqual({
      type: "workspace_readwrite",
      additionalReadwritePaths: writableRoots(),
    });
    expect(await prep("read-only")).toBe("ok");
    expect(policy("read-only")).toEqual({ type: "workspace_readonly" });
    expect(await prep("full")).toBe("ok");
    expect(existsSync(join(isolatedCursorHome("full", true), ".cursor", "sandbox.json"))).toBe(false);
    // a resume under another access finds its chat: every isolated home shares one chats dir
    const chats = join(isolatedCursorHome("read-only", true), ".cursor", "chats");
    expect(lstatSync(chats).isSymbolicLink()).toBe(true);
    expect(readlinkSync(chats)).toBe(join(isolatedCursorRoot(), "chats"));
    expect(await prep("read-only")).toBe("ok"); // again: the link stays
  });
});

describe("cursor access probes (spec 1.3 §4.7, §3.4)", () => {
  it("runs doctor's probes through the hidden `cursor-agent sandbox run`, naming the sandbox.json fixes", async () => {
    process.env.PATH = SIMS;
    const argsTo = join(mkdtempSync(join(tmpdir(), "catherd-sbx-")), "args.jsonl");
    Object.assign(process.env, withCursorScenario({ sandboxArgsTo: argsTo }).env);
    const shell = (await cursorAdapter.accessShell?.({ network: true })) as AccessShell;
    expect(shell.how).toBe("Cursor's sandbox (cursor-agent sandbox run)");
    // the runner joins its args and re-shells them: quotes, spaces, `$` and empty args survive
    expect(
      (await shell.run(`printf "[%s]" "$#" "$@"; echo "it's"`, ["it's a $HOME", "(x) && y", ""]))?.out,
    ).toBe("[3][it's a $HOME][(x) && y][]it's\n");
    shell.close();
    const calls = readFileSync(argsTo, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toEqual([
      ["sandbox", "run", "--", "'sh' '-c' 'true' '_'"],
      [
        "sandbox",
        "run",
        "--",
        `'sh' '-c' 'printf "[%s]" "$#" "$@"; echo "it'\\''s"' '_' 'it'\\''s a $HOME' '(x) && y' ''`,
      ],
    ]);
    expect(shell.fixes?.lock).toContain("additionalReadwritePaths");
    expect(shell.fixes?.https).toContain("networkPolicy");
  });

  it("breaks a split argv the way the real runner does, which is why the probes go as one line", async () => {
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({}).env);
    const dir = mkdtempSync(join(tmpdir(), "catherd-sbx-"));
    const ran = join(dir, "ran");
    writeFileSync(join(dir, "fake-docker"), `#!/bin/sh\necho "$@" > '${ran}'\n`);
    chmodSync(join(dir, "fake-docker"), 0o755);
    const split = scratchShell("split", ["cursor-agent", "sandbox", "run", "--"]);
    try {
      expect((await split.run("true", []))?.ok).toBe(true);
      expect((await split.run('f="$1/x" && touch "$f" && rm -f "$f"', [dir]))?.ok).toBe(false);
      // `sh -c "$1" version _ <docker>` re-shelled: an empty script that exits 0 and runs nothing
      expect((await split.run('"$1" version', [join(dir, "fake-docker")]))?.ok).toBe(true);
      expect(existsSync(ran)).toBe(false);
    } finally {
      split.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says why when this Cursor has no sandbox runner", async () => {
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ sandbox: "missing" }).env);
    expect(await cursorAdapter.accessShell?.({ network: true })).toBe(
      "no Cursor sandbox runner here: cursor-agent sandbox run (hidden) did not run `true`",
    );
  });
});

describe("cursor isolated home, two catherd processes at once (Codex, PR #30)", () => {
  it("accepts a chats link another process made first, and refuses one pointing elsewhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-link-"));
    try {
      const target = join(dir, "chats");
      const link = join(dir, "home-chats");
      symlinkSync(target, link); // the other process won the race
      expect(() => ensureLink(target, link)).not.toThrow();
      expect(readlinkSync(link)).toBe(target);
      const other = join(dir, "other");
      symlinkSync(join(dir, "elsewhere"), other);
      expect(() => ensureLink(target, other)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

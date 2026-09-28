import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeHome } from "../../src/infra/paths.ts";
import { configDir, runsDir } from "../../src/infra/paths.ts";
import { findRun } from "../../src/services/run-store.ts";
import { passGate } from "../services/helpers.ts";
import { defaultProfileDoc } from "../../src/domain/profile.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { call } from "../mcp-helpers.ts";
import { fakeInbox } from "../sim/peer-inbox.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
  version: string;
};
const LIMIT: CodexScenario = { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 };

/** The environment a Claude Code session would start `catherd mcp` with, pointed at the simulator. */
function serverEnv(home: string, scenarioFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "TYPESAFE_API_KEY" && k !== "ANTHROPIC_API_KEY") env[k] = v;
  return {
    ...env,
    CATHERD_HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    PATH: simPath(),
    CATHERD_SIM_SCENARIO: scenarioFile,
    // a root container runs this suite too: preflight runs its checks there only on a disposable machine
    IS_SANDBOX: "1",
  };
}

const servers = new Map<Client, StdioClientTransport>();

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "catherd-it", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env,
    stderr: "ignore",
  });
  await client.connect(transport);
  servers.set(client, transport);
  return client;
}

/**
 * The server dies at once, while a role runs. Closing stdin alone is not enough: the server lives on
 * until the SDK's SIGTERM 2 s later, and a role that finishes first is recorded by that server itself,
 * which leaves the next server nothing to reconcile.
 */
async function crash(c: Client): Promise<void> {
  const pid = servers.get(c)?.pid;
  if (!pid) throw new Error("no server process");
  process.kill(pid, "SIGKILL");
  await c.close();
}

/** Whether a dispatch of this role has an exit.json: its supervisor saw the worker finish. */
function finishedOnDisk(dir: string, name: string): boolean {
  const roleDir = join(dir, "roles", name);
  if (!existsSync(roleDir)) return false;
  return readdirSync(roleDir, { withFileTypes: true }).some(
    (e) => e.isDirectory() && existsSync(join(roleDir, e.name, "exit.json")),
  );
}

/** The user's profile file: the default profile document, with fields replaced. */
function writeProfile(extra: Record<string, unknown>): void {
  mkdirSync(join(configDir(), "profiles"), { recursive: true });
  writeFileSync(
    join(configDir(), "profiles", "default.json"),
    JSON.stringify({ ...defaultProfileDoc(), ...extra }),
  );
}

function commitAll(repo: string): string {
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  git("add", "-A");
  git("commit", "-qm", "M1");
  return git("rev-parse", "--short", "HEAD");
}

async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

/** runs.jsonl's whole rows; a torn tail line is skipped, as catherd's own reader does. */
function recordsOf(dir: string): { dispatchId: string; status: string; name: string }[] {
  return readFileSync(join(dir, "runs.jsonl"), "utf8")
    .split("\n")
    .slice(1)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { dispatchId: string; status: string; name: string }];
      } catch {
        return [];
      }
    });
}

const lane = (id: string, owns: string, check: string) =>
  `# ${id} — test lane\nOwns: ${owns}\nFast check: ${check}\nKind: repo_code\nDifficulty: build\n`;

function setup() {
  const home = withHome();
  delete process.env.TYPESAFE_API_KEY;
  const repo = tempRepo();
  const sim = withScenario({});
  return { home, repo, sim, env: serverEnv(home, sim.file) };
}

describe("the server's environment", () => {
  it("never passes the user's Anthropic or TypeSafe key through", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    process.env.TYPESAFE_API_KEY = "tsk-fake";
    const env = serverEnv("/tmp/h", "/tmp/s.json");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
  });
});

describe("catherd mcp over stdio, on the Codex simulator", () => {
  it(
    "runs a lane from run_start to reconcile after a server restart",
    async () => {
      const { repo, sim, env } = setup();
      let c = await connect(env);

      expect((await call(c, "status")).data.version).toBe(PKG.version);
      const started = await call(c, "run_start", { repo, title: "Add a", a_lines: ["A1 a exists"] });
      const { run, dir } = started.data as { run: string; dir: string };
      await call(c, "write_run_file", {
        run,
        path: "lanes/M1.L1.md",
        content: lane("M1.L1", "src/a.ts", "grep -q fixed src/a.ts"),
      });
      await call(c, "write_run_file", {
        run,
        path: "lanes/M1.L2.md",
        content: lane("M1.L2", "src/b.ts", "test -f README.md"),
      });

      // route: no Jev key, so the lane file's Kind/Difficulty decide: Track A.
      const routed = await call(c, "route", { run, lane_file: "lanes/M1.L1.md" });
      expect(routed.data).toMatchObject({ source: "lane", rung: "codex:gpt-6-luna#high", backend: "codex" });

      // preflight: M1.L1 checks a file it creates; M1.L2's check runs and fails as expected.
      const pre = await call(c, "preflight", { run });
      expect(pre.data.results.map((r: { outcome: string }) => r.outcome)).toEqual([
        "skipped",
        "fails-as-expected",
      ]);
      expect(pre.data.blocked).toBe(false);

      // dispatch at Luna, which returns at launch; the server records the refusal; result reads it; climb.
      const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
      sim.rewrite({
        eventsFile: join(FX, "two-turns.jsonl"),
        reply: "Tried.\nSTATUS: refused — needs a stronger model",
        holdUntil: release,
      });
      const worker = {
        run,
        role: "worker",
        name: "worker-M1.L1",
        brief: "Read lanes/M1.L1.md",
        lane: "M1.L1",
      };
      const launched = await call(c, "dispatch", { ...worker, rung: "codex:gpt-6-luna#high" });
      expect(launched.data.dispatched).toMatchObject({ name: "worker-M1.L1", rung: "codex:gpt-6-luna#high" });
      expect(Date.parse(launched.data.dispatched.admittedAt)).toBeGreaterThan(0);
      expect((await call(c, "status", { run })).data.runs[0].live).toHaveLength(1);
      writeFileSync(release, "");
      await until(async () => recordsOf(dir).length === 1);
      const refused = (await call(c, "result", { run, name: "worker-M1.L1" })).data;
      expect(refused.record).toMatchObject({ status: "ok", replyStatus: "refused" });
      expect(refused.hints).toContain("climb: refused");
      const climbed = await call(c, "climb", { run, lane: "M1.L1", reason: "refused" });
      // the build ladder is Luna high, then Sol xhigh (spec 1.2 §5.2: the median DeepSWE bar, 66.6)
      expect(climbed.data).toMatchObject({ rung: "codex:gpt-6-sol#xhigh", top: false });

      // failover: Sol medium hits a usage limit; its stand-in Sol high finishes the lane.
      writeProfile({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } });
      sim.rewrite({
        byRung: {
          "gpt-6-sol#medium": LIMIT,
          "gpt-6-sol#high": {
            eventsFile: join(FX, "ok-with-reconnect.jsonl"),
            reply: "Done.\nSTATUS: complete — a works",
            touch: [{ path: "src/a.ts", content: "fixed" }],
          },
        },
      });
      const failed = await call(c, "dispatch", { ...worker, rung: "codex:gpt-6-sol#medium" });
      expect(failed.data.dispatched.rung).toBe("codex:gpt-6-sol#medium");
      // the server records the limit and launches the stand-in at once; result reads both, the limit's hint first
      await until(async () => recordsOf(dir).length === 3);
      expect(recordsOf(dir).map((r) => r.status)).toEqual(["ok", "limit", "ok"]);
      const stood = (await call(c, "result", { run, name: "worker-M1.L1" })).data;
      expect(stood.record).toMatchObject({
        status: "ok",
        rung: "codex:gpt-6-sol#high",
        failoverFrom: "codex:gpt-6-sol#medium",
        changedOwned: ["src/a.ts"],
      });
      expect(stood.hints[0]).toBe(
        "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
      );

      // land: five columns with minutes, and what it learned goes to the repo's knowledge.
      const sha = commitAll(repo);
      // spec 1.1 §6: no reviewer and no verifier yet, so land refuses the milestone
      const gated = { run, milestone: "M1", what: "a", commit: sha, evidence: "grep ok", next: "M1.L2" };
      expect((await call(c, "land", gated)).error?.code).toBe("E_LAND_GATE");
      await passGate(findRun(run), "M1");
      const landed = await call(c, "land", {
        run,
        milestone: "M1",
        what: "a",
        commit: sha,
        evidence: "grep ok",
        next: "M1.L2",
        learned: "the fast check is instant",
      });
      expect(landed.data.ledger.split(" | ")).toHaveLength(5);
      expect((await call(c, "read_knowledge", { repo })).raw).toContain("the fast check is instant");

      // budget stop: past the cap, admission refuses a new role before anything starts.
      writeProfile({ budget: { tokens: 1000 } });
      const second = {
        run,
        role: "worker",
        name: "worker-M1.L2",
        brief: "Read lanes/M1.L2.md",
        lane: "M1.L2",
        rung: "codex:gpt-6-luna#high",
      };
      const stopped = await call(c, "dispatch", second);
      expect(stopped.error?.code).toBe("E_RUN_BUDGET");
      expect(stopped.error?.fix).toBeTruthy();
      writeProfile({});

      // cancel: a hanging role is stopped and recorded once as cancelled.
      sim.rewrite({ hangMs: 60_000 });
      expect((await call(c, "dispatch", second)).isError).toBe(false);
      await until(async () =>
        (await call(c, "status", { run })).data.runs[0].live.some(
          (l: { state: string }) => l.state === "running",
        ),
      );
      const cancelled = await call(c, "cancel", { run, name: "worker-M1.L2" });
      expect(cancelled.data.record.status).toBe("cancelled");
      expect(recordsOf(dir).filter((r) => r.dispatchId === cancelled.data.record.dispatchId)).toHaveLength(1);

      // restart mid-run: the server dies while a role runs; the next server records it, once.
      sim.rewrite({
        delayMs: 2_000,
        eventsFile: join(FX, "two-turns.jsonl"),
        reply: "ok\nSTATUS: complete — b",
        touch: [{ path: "src/b.ts", content: "b" }],
      });
      const recordedBefore = recordsOf(dir).length;
      expect((await call(c, "dispatch", second)).isError).toBe(false);
      await crash(c);
      // the dead server recorded nothing: the record below is the next server's
      expect(recordsOf(dir)).toHaveLength(recordedBefore);
      c = await connect(env);
      await until(async () => recordsOf(dir).length === recordedBefore + 1);
      const done = (await call(c, "result", { run, name: "worker-M1.L2" })).data.record;
      expect(done.status).toBe("ok");
      expect(done.changedOwned).toEqual(["src/b.ts"]);
      const ids = recordsOf(dir).map((r) => r.dispatchId);
      expect(new Set(ids).size).toBe(ids.length);
      expect((await call(c, "status", { run })).data.runs[0].live).toEqual([]);
      await c.close();
    },
    { timeout: 120_000 },
  );
});

describe("push over stdio (spec §15)", () => {
  it(
    "announces two workers on the session's inbox while the client makes other calls; then peek and result",
    async () => {
      const { repo, sim, env } = setup();
      const inbox = await fakeInbox();
      // the Claude Code session the server runs in: its registry file names the fake inbox
      mkdirSync(join(claudeHome(), "sessions"), { recursive: true });
      writeFileSync(
        join(claudeHome(), "sessions", "4242.json"),
        JSON.stringify({ pid: 4242, sessionId: "s-it", name: "it session", messagingSocketPath: inbox.path }),
      );
      const c = await connect({
        ...env,
        CLAUDE_CODE_SESSION_ID: "s-it",
        CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
        CLAUDE_CODE_MESSAGING_TOKEN: "child-token",
      });
      try {
        const { run } = (await call(c, "run_start", { repo, title: "Push it", a_lines: ["A1"] })).data;
        for (const [id, owns] of [
          ["M1.L1", "src/a.ts"],
          ["M1.L2", "src/b.ts"],
        ] as const)
          await call(c, "write_run_file", { run, path: `lanes/${id}.md`, content: lane(id, owns, "true") });
        const [a, b] = [0, 1].map(() => join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release"));
        sim.rewrite({
          byRung: {
            "gpt-6-luna#high": { reply: "A done.\nSTATUS: complete — a", holdUntil: a },
            // Sol xhigh: on the build ladder (Luna high, Sol xhigh) the lanes are routed on
            "gpt-6-sol#xhigh": { reply: "B done.\nSTATUS: complete — b", holdUntil: b },
          },
        });
        const base = { run, role: "worker", brief: "b" };
        await call(c, "dispatch", {
          ...base,
          name: "worker-M1.L1",
          lane: "M1.L1",
          rung: "codex:gpt-6-luna#high",
        });
        await call(c, "dispatch", {
          ...base,
          name: "worker-M1.L2",
          lane: "M1.L2",
          rung: "codex:gpt-6-sol#xhigh",
        });
        writeFileSync(a as string, "");
        // the client keeps working while the first notice is on its way
        const first = inbox.received(1, 20_000);
        const live = await until(async () => {
          const p = (await call(c, "peek", { run })).data.runs[0];
          return p.unread.length === 1 && p.live.length === 1 ? p : null;
        });
        expect(live.live[0].name).toBe("worker-M1.L2");
        expect(live.unread[0].header).toMatch(/^catherd · Push it · worker-M1\.L1 worker · /);
        const [f1] = await first;
        expect(f1?.auth).toEqual({ type: "auth", token: "child-token" });
        expect(f1?.priority).toBe("later");
        expect(f1?.message.content).toContain('Record: result(run: "' + run + '", name: "worker-M1.L1")');
        writeFileSync(b as string, "");
        expect((await call(c, "status", { run })).isError).toBe(false);
        const frames = await inbox.received(2, 20_000);
        expect(frames[1]?.message.content).toContain("worker-M1.L2 worker");
        // announced, not read: peek lists both until result reads them
        expect((await call(c, "peek", { run })).data.runs[0].unread).toHaveLength(2);
        const r1 = (await call(c, "result", { run, name: "worker-M1.L1" })).data;
        expect(r1.record).toMatchObject({ status: "ok", replyStatus: "complete" });
        await call(c, "result", { run, name: "worker-M1.L2" });
        expect((await call(c, "peek", { run })).data.runs[0].unread).toEqual([]);
        expect(inbox.frames).toHaveLength(2);
      } finally {
        await c.close();
        await inbox.close();
      }
    },
    { timeout: 90_000 },
  );
});

describe("concurrency and corruption, over stdio", () => {
  it(
    "admits one of two parallel overlapping dispatches, and one of two with the same name",
    async () => {
      const { repo, sim, env } = setup();
      const c = await connect(env);
      const { run, dir } = (await call(c, "run_start", { repo, title: "p", a_lines: ["A1"] })).data;
      await call(c, "write_run_file", {
        run,
        path: "lanes/M1.L1.md",
        content: lane("M1.L1", "src/", "true"),
      });
      await call(c, "write_run_file", {
        run,
        path: "lanes/M1.L2.md",
        content: lane("M1.L2", "src/c.ts", "true"),
      });
      sim.rewrite({ delayMs: 500, reply: "x\nSTATUS: complete — ok" });
      const base = { run, role: "worker", brief: "b", rung: "codex:gpt-6-luna#high" };
      const lanes = await Promise.all([
        call(c, "dispatch", { ...base, name: "worker-M1.L1", lane: "M1.L1" }),
        call(c, "dispatch", { ...base, name: "worker-M1.L2", lane: "M1.L2" }),
      ]);
      expect(lanes.map((r) => r.error?.code ?? "ok").sort()).toEqual(["E_ADMIT_OVERLAP", "ok"]);
      const names = await Promise.all([
        call(c, "dispatch", { ...base, name: "writer", role: "writer" }),
        call(c, "dispatch", { ...base, name: "writer", role: "writer" }),
      ]);
      expect(names.map((r) => r.error?.code ?? "ok").sort()).toEqual(["E_ADMIT_DUPLICATE", "ok"]);
      await until(async () => recordsOf(dir).length === 2);
      expect(recordsOf(dir).map((r) => r.status)).toEqual(["ok", "ok"]);
      await c.close();
    },
    { timeout: 60_000 },
  );

  it(
    "writes one record when two restarted servers reconcile the same finished dispatch",
    async () => {
      const { repo, sim, env } = setup();
      const c = await connect(env);
      const { run, dir } = (await call(c, "run_start", { repo, title: "r", a_lines: ["A1"] })).data;
      sim.rewrite({ delayMs: 2_000, reply: "x\nSTATUS: complete — ok" });
      const launched = await call(c, "dispatch", {
        run,
        role: "writer",
        name: "writer",
        brief: "b",
        rung: "codex:gpt-6-luna#high",
      });
      expect(launched.isError).toBe(false);
      await crash(c);
      // the dispatch finishes with no server alive, so both new servers find it finished and unrecorded
      await until(async () => finishedOnDisk(dir, "writer"));
      expect(recordsOf(dir)).toEqual([]);
      const [a, b] = await Promise.all([connect(env), connect(env)]);
      await until(async () => recordsOf(dir).length > 0);
      await Bun.sleep(500);
      expect(recordsOf(dir)).toHaveLength(1);
      await Promise.all([a.close(), b.close()]);
    },
    { timeout: 60_000 },
  );

  it(
    "starts beside a corrupt run, and keeps working on a run whose runs.jsonl ends in a torn line",
    async () => {
      const { repo, sim, env } = setup();
      const c = await connect(env);
      const { run, dir } = (await call(c, "run_start", { repo, title: "t", a_lines: ["A1"] })).data;
      await c.close();
      mkdirSync(join(runsDir(repo), "20200101-000000-broken"));
      writeFileSync(join(runsDir(repo), "20200101-000000-broken", "meta.json"), "{ torn");
      appendFileSync(join(dir, "runs.jsonl"), '{"schema":1,"runId":"x","dispa');

      const c2 = await connect(env);
      const s = await call(c2, "status");
      expect(s.isError).toBe(false);
      expect(s.data.warnings.join()).toContain("20200101-000000-broken");
      expect((await call(c2, "status", { run: "20200101-000000-broken" })).error?.code).toBe("E_RUN_CORRUPT");
      sim.rewrite({ reply: "x\nSTATUS: complete — ok" });
      const r = await call(c2, "dispatch", {
        run,
        role: "writer",
        name: "writer",
        brief: "b",
        rung: "codex:gpt-6-luna#high",
      });
      expect(r.data.dispatched.name).toBe("writer");
      await until(async () => recordsOf(dir).length === 1);
      expect((await call(c2, "result", { run, name: "writer" })).data.record.status).toBe("ok");
      expect(recordsOf(dir).map((x) => x.status)).toEqual(["ok"]);
      await c2.close();
    },
    { timeout: 60_000 },
  );
});

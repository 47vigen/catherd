import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendRunRecord, clearLive, readJsonl, readRunRecords, writeLive } from "../src/core/runstore.ts";
import { defaultProfile, saveProfile } from "../src/profile/profile.ts";
import { fakeRecord } from "./records.ts";
import { fakeBinPath, tempRepo, withHome } from "./helpers.ts";
import { call, mcpClient, startRun } from "./mcp-helpers.ts";

const fx = (n: string) => join(import.meta.dir, "fixtures", "codex", n);
const fxOc = (n: string) => join(import.meta.dir, "fixtures", "opencode", n);
const lane = (owns: string) => `# M1.L1 — x\nOwns: ${owns}\nFast check: true\n`;
const lastLine = (f: string) => readFileSync(f, "utf8").trimEnd().split("\n").at(-1);

async function setup(owns = "a.ts") {
  const c = await mcpClient();
  const repo = tempRepo();
  const { run, dir } = await startRun(c, repo);
  await call(c, "write_run_file", { run, path: "lanes/M1.L1.md", content: lane(owns) });
  return { c, repo, run, dir };
}

const base = (run: string) => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "BRIEF TEXT",
  rung: "gpt-6-sol#medium",
  lane: "M1.L1",
});

describe("dispatch", () => {
  let home: string;
  beforeEach(() => {
    home = withHome();
    delete process.env.TYPESAFE_API_KEY;
    process.env.CODEX_HOME = join(home, "user-codex");
    process.env.PATH = fakeBinPath();
    process.env.CATHERD_TICK_MS = "200";
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_CODEX_")) delete process.env[k];
    process.env.FAKE_CODEX_EVENTS = fx("ok-with-reconnect.jsonl");
    process.env.FAKE_CODEX_REPLY = "done\nSTATUS: complete — green";
  });

  test("writes the brief, runs the role, and returns its record with no hints", async () => {
    const { c, repo, run, dir } = await setup();
    process.env.FAKE_CODEX_TOUCH = join(repo, "a.ts");
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");
    const r = await call(c, "dispatch", base(run));
    expect(r.isError).toBe(false);
    expect(r.data.record).toMatchObject({
      name: "worker-M1.L1",
      status: "ok",
      changedOwned: ["a.ts"],
      replyStatus: "complete",
    });
    expect(r.data.hints).toEqual([]);
    expect(readFileSync(join(dir, "roles", "worker-M1.L1.md"), "utf8")).toBe("BRIEF TEXT");
    expect(JSON.parse(readFileSync(join(home, "args.json"), "utf8")).stdin).toBe("BRIEF TEXT");
    expect(readRunRecords(dir)).toHaveLength(1);
    expect(readFileSync(join(dir, "state.md"), "utf8")).toContain("Running:\n- none");
  });

  test("records the first-turn input of a fresh native run for the harness estimate", async () => {
    const { c, run, dir } = await setup();
    await call(c, "dispatch", base(run));
    expect(readJsonl(join(dir, "harness.jsonl"))).toMatchObject([
      { name: "worker-M1.L1", backend: "codex", isolated: false, firstTurnInput: 898388 },
    ]);
  });

  test("passes the profile's harness isolation to the runner, and records it", async () => {
    saveProfile({
      ...defaultProfile(),
      harness: { codex: { isolated: true }, opencode: { isolated: false } },
    });
    const { c, run, dir } = await setup();
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");
    await call(c, "dispatch", base(run));
    expect(JSON.parse(readFileSync(join(home, "args.json"), "utf8")).args).toContain("--ignore-user-config");
    expect(readJsonl<{ isolated: boolean }>(join(dir, "harness.jsonl"))[0]?.isolated).toBe(true);
  });

  test("runs natively by default: no --ignore-user-config", async () => {
    const { c, run } = await setup();
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");
    await call(c, "dispatch", base(run));
    expect(JSON.parse(readFileSync(join(home, "args.json"), "utf8")).args).not.toContain(
      "--ignore-user-config",
    );
  });

  test("streams progress while the role runs, when the client asks for it", async () => {
    const { c, run } = await setup();
    process.env.FAKE_CODEX_DELAY_MS = "900";
    const ticks: { progress: number; message?: string }[] = [];
    const r = await call(c, "dispatch", base(run), (p) => ticks.push(p));
    expect(r.isError).toBe(false);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]?.message).toContain("worker-M1.L1 · gpt-6-sol#medium");
  });

  test("shows the role as running in state.md while it runs", async () => {
    const { c, run, dir } = await setup();
    process.env.FAKE_CODEX_DELAY_MS = "900";
    const pending = call(c, "dispatch", base(run));
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(join(dir, "state.md"), "utf8")).toContain("worker-M1.L1 · gpt-6-sol#medium");
    await pending;
  });

  test("resumes a thread with the brief as the fix file, and records no harness row", async () => {
    const { c, run, dir } = await setup();
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");
    await call(c, "dispatch", { ...base(run), thread: "t-two", brief: "FIX TEXT" });
    expect(readFileSync(join(dir, "roles", "worker-M1.L1.fix.md"), "utf8")).toBe("FIX TEXT");
    expect(JSON.parse(readFileSync(join(home, "args.json"), "utf8")).args.slice(0, 2)).toEqual([
      "exec",
      "resume",
    ]);
    expect(existsSync(join(dir, "harness.jsonl"))).toBe(false);
  });

  test("hints a climb when the run leaves its owned files unchanged", async () => {
    const { c, run } = await setup();
    const r = await call(c, "dispatch", base(run));
    expect(r.data.hints).toEqual(["climb: unchanged"]);
  });

  test("writes the pause into state.md on a usage limit", async () => {
    const { c, run, dir } = await setup();
    process.env.FAKE_CODEX_EVENTS = fx("limit.jsonl");
    process.env.FAKE_CODEX_EXIT = "1";
    const r = await call(c, "dispatch", base(run));
    expect(r.data.record.status).toBe("limit");
    expect(r.data.hints[0]).toMatch(/^limit: /);
    expect(lastLine(join(dir, "state.md"))).toBe(
      "Next: paused: codex usage limit; resume when the user says so",
    );
  });

  test("refuses a Claude rung and names the agent to run instead", async () => {
    const { c, run } = await setup();
    const r = await call(c, "dispatch", {
      ...base(run),
      role: "verifier",
      name: "verifier-M1",
      rung: "claude-opus-5-5#low",
      lane: undefined,
    });
    expect(r.isError).toBe(true);
    expect(r.raw).toContain('Agent(subagent_type: "catherd-verifier-claude-opus-5-5-low")');
  });

  test("refuses a lane that owns a file a running role owns, and starts nothing", async () => {
    const { c, repo, run, dir } = await setup("a.ts, b.ts");
    writeLive(dir, {
      name: "worker-M1.L9",
      role: "worker",
      backend: "codex",
      rung: "gpt-6-sol#medium",
      pid: process.pid,
      thread: null,
      startedAt: new Date().toISOString(),
      cwd: repo,
      ownedFiles: ["b.ts"],
      before: {},
      isolated: false,
    });
    const r = await call(c, "dispatch", base(run));
    expect(r.isError).toBe(true);
    expect(r.raw).toContain("b.ts");
    expect(r.raw).toContain("worker-M1.L9");
    expect(existsSync(join(dir, "roles", "worker-M1.L1.md"))).toBe(false);
    clearLive(dir, "worker-M1.L9");
  });

  test("refuses a lane file without an Owns: line, and a name that is a path", async () => {
    const { c, run } = await setup();
    await call(c, "write_run_file", { run, path: "lanes/M1.L2.md", content: "# M1.L2 — no owners\n" });
    const noOwns = await call(c, "dispatch", { ...base(run), name: "worker-M1.L2", lane: "M1.L2" });
    expect(noOwns.raw).toContain('no "Owns:" line');
    const evil = await call(c, "dispatch", { ...base(run), name: "../evil" });
    expect(evil.isError).toBe(true);
  });

  test("fails over to the profile's stand-in on a limit, and says so in the result (v1)", async () => {
    saveProfile({ ...defaultProfile(), failover: { "gpt-6-sol#medium": "someprovider/some-model#default" } });
    const { c, run, dir } = await setup();
    process.env.FAKE_CODEX_EVENTS = fx("limit.jsonl");
    process.env.FAKE_CODEX_EXIT = "1";
    process.env.FAKE_OC_EVENTS = fxOc("ok.jsonl");
    const r = await call(c, "dispatch", base(run));
    expect(r.isError).toBe(false);
    expect(r.data.record.rung).toBe("someprovider/some-model#default");
    expect(r.data.record.backend).toBe("opencode");
    expect(r.data.record.status).toBe("ok");
    expect(r.data.hints[0]).toBe(
      "limit: worker gpt-6-sol#medium hit a usage limit; failed over to someprovider/some-model#default",
    );
    expect(readJsonl(join(dir, "harness.jsonl"))).toEqual([]);
  });

  test("names the Claude agent when the failover stand-in is a Claude rung", async () => {
    saveProfile({ ...defaultProfile(), failover: { "gpt-6-sol#medium": "claude-opus-5-5#high" } });
    const { c, run } = await setup();
    process.env.FAKE_CODEX_EVENTS = fx("limit.jsonl");
    process.env.FAKE_CODEX_EXIT = "1";
    const r = await call(c, "dispatch", base(run));
    expect(r.data.record.status).toBe("limit");
    expect(r.data.hints[0]).toContain('Agent(subagent_type: "catherd-worker-claude-opus-5-5-high")');
  });

  test("refuses to dispatch once the run budget is spent (v1)", async () => {
    saveProfile({ ...defaultProfile(), budget: { minutes: 1 } });
    const { c, run, dir } = await setup();
    appendRunRecord(dir, fakeRecord("worker-M1.L0", { secs: 60 }));
    const r = await call(c, "dispatch", base(run));
    expect(r.isError).toBe(true);
    expect(r.raw).toContain("run budget exhausted");
    expect(r.raw).toContain("1/1 min");
    expect(existsSync(join(dir, "roles", "worker-M1.L1.md"))).toBe(false);
  });
});

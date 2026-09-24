import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { opencodeArgs, opencodeConfigHome, runOpencode } from "../src/core/opencode.ts";
import { createRun, rolePaths } from "../src/core/runstore.ts";
import { fakeBinPath, tempRepo, withHome } from "./helpers.ts";

const fx = (n: string) => join(import.meta.dir, "fixtures", "opencode", n);
const calls = (f: string) =>
  readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);

describe("opencode runner", () => {
  let home: string;
  beforeEach(() => {
    home = withHome();
    process.env.PATH = fakeBinPath();
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_OC_")) delete process.env[k];
    process.env.FAKE_OC_CALLS = join(home, "calls.jsonl");
    process.env.XDG_CONFIG_HOME = join(home, "user-xdg");
  });

  const base = (dir: string, repo: string) => ({
    runDir: dir,
    name: "worker-M1.L1",
    role: "worker" as const,
    rung: "openrouter/qwen/qwen3-coder#high",
    cwd: repo,
    ownedFiles: ["a.ts"],
  });

  test("builds args: variant from effort, read-only roles use explore + auto, isolated adds --standalone", () => {
    expect(opencodeArgs(base("/d", "/r"), "B")).toEqual([
      "run",
      "--format",
      "json",
      "-m",
      "openrouter/qwen/qwen3-coder#high",
      "B",
    ]);
    expect(
      opencodeArgs({ ...base("/d", "/r"), role: "reviewer", rung: "opencode/big#default" }, "B"),
    ).toEqual(["run", "--format", "json", "-m", "opencode/big", "--agent", "explore", "--auto", "B"]);
    expect(opencodeArgs({ ...base("/d", "/r"), role: "verifier", thread: "ses_1" }, "B")).toEqual([
      "run",
      "--format",
      "json",
      "-m",
      "openrouter/qwen/qwen3-coder#high",
      "--auto",
      "-s",
      "ses_1",
      "B",
    ]);
    expect(opencodeArgs({ ...base("/d", "/r"), isolated: true }, "B")).toEqual([
      "run",
      "--standalone",
      "--format",
      "json",
      "-m",
      "openrouter/qwen/qwen3-coder#high",
      "B",
    ]);
  });

  test("runs natively in the user's config home, and isolated in catherd's empty one", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_OC_EVENTS = fx("ok.jsonl");
    process.env.FAKE_OC_ENV = join(home, "env.json");
    const seenEnv = () =>
      JSON.parse(readFileSync(process.env.FAKE_OC_ENV!, "utf8")) as { xdgConfigHome: string | null };

    await runOpencode(base(run.dir, repo));
    expect(seenEnv().xdgConfigHome).toBe(join(home, "user-xdg"));

    await runOpencode({ ...base(run.dir, repo), isolated: true });
    expect(seenEnv().xdgConfigHome).toBe(opencodeConfigHome());
    expect(opencodeConfigHome()).not.toBe(join(home, "user-xdg"));
    expect(calls(process.env.FAKE_OC_CALLS!).at(-2)?.slice(0, 2)).toEqual(["run", "--standalone"]);
  });

  test("records a completed run with reply, session, cost and changed files", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "BRIEF");
    process.env.FAKE_OC_EVENTS = fx("ok.jsonl");
    process.env.FAKE_OC_TOUCH = join(repo, "a.ts");
    process.env.FAKE_OC_COST = "0.0123";
    const r = await runOpencode(base(run.dir, repo));
    expect(r.status).toBe("ok");
    expect(r.thread).toBe("ses_ok1");
    expect(r.costUsd).toBeCloseTo(0.0123);
    expect(r.changedOwned).toEqual(["a.ts"]);
    expect(r.replyStatus).toBe("complete");
    expect(readFileSync(r.replyPath, "utf8")).toContain("Changed a.ts.");
  });

  test("does not fail a run on a tool error", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_OC_EVENTS = fx("tool-error-ok.jsonl");
    expect((await runOpencode(base(run.dir, repo))).status).toBe("ok");
  });

  test("fails on an error event and keeps the message", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_OC_EVENTS = fx("error.jsonl");
    process.env.FAKE_OC_EXIT = "1";
    const r = await runOpencode(base(run.dir, repo));
    expect(r.status).toBe("failed");
    expect(r.error).toContain("insufficient credit");
  });

  test("interrupts a quiet, idle session server-side and records timeout", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_OC_EVENTS = fx("ok.jsonl");
    process.env.FAKE_OC_HANG_MS = "10000";
    const r = await runOpencode({ ...base(run.dir, repo), idleSecs: 1 });
    expect(r.status).toBe("timeout");
    expect(calls(process.env.FAKE_OC_CALLS!)).toContainEqual([
      "api",
      "POST",
      "/api/session/ses_ok1/interrupt",
    ]);
  });

  test("does not time out while the server reports a running tool", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_OC_EVENTS = fx("ok.jsonl");
    process.env.FAKE_OC_HANG_MS = "2500";
    process.env.FAKE_OC_BUSY = "1";
    const r = await runOpencode({ ...base(run.dir, repo), idleSecs: 1 });
    expect(r.status).toBe("ok");
  });
});

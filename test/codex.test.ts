import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { codexHome, runCodex, userCodexHome } from "../src/core/codex.ts";
import { createRun, readLive, readRunRecords, rolePaths } from "../src/core/runstore.ts";
import { fakeBinPath, tempRepo, withHome } from "./helpers.ts";

const fx = (n: string) => join(import.meta.dir, "fixtures", "codex", n);

describe("runCodex", () => {
  let home: string;
  beforeEach(() => {
    home = withHome();
    process.env.PATH = fakeBinPath();
    process.env.CATHERD_TICK_MS = "300";
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_CODEX_")) delete process.env[k];
    process.env.CODEX_HOME = join(home, "user-codex");
  });

  test("runs natively: brief on stdin, the user's own CODEX_HOME and config, stdout on a file", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "BRIEF TEXT");
    process.env.FAKE_CODEX_EVENTS = fx("ok-with-reconnect.jsonl");
    process.env.FAKE_CODEX_REPLY = "done\nSTATUS: complete — green";
    process.env.FAKE_CODEX_TOUCH = join(repo, "a.ts");
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");

    const r = await runCodex({
      runDir: run.dir,
      name: "worker-M1.L1",
      role: "worker",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: ["a.ts"],
    });

    const seen = JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGS!, "utf8"));
    expect(seen.stdin).toBe("BRIEF TEXT");
    expect(seen.args.slice(0, 6)).toEqual([
      "exec",
      "-m",
      "gpt-6-sol",
      "-c",
      "model_reasoning_effort=medium",
      "--json",
    ]);
    expect(seen.args).not.toContain("--ignore-user-config");
    expect(seen.args[seen.args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(seen.args.at(-1)).toBe("-");
    expect(seen.codexHome).toBe(join(home, "user-codex"));
    expect(seen.stdoutIsFile).toBe(true);

    expect(r.status).toBe("ok");
    expect(r.thread).toBe("01a0d0d4-d0a6-71a1-983c-82a9169200b4");
    expect(r.replyStatus).toBe("complete");
    expect(r.changedOwned).toEqual(["a.ts"]);
    expect(r.threadHeavy).toBe(false);
    expect(readRunRecords(run.dir)).toHaveLength(1);
    expect(readLive(run.dir)).toEqual([]);
  });

  test("runs isolated: --ignore-user-config and catherd's CODEX_HOME holding only the auth link", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    mkdirSync(userCodexHome(), { recursive: true });
    writeFileSync(join(userCodexHome(), "auth.json"), "{}");
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_CODEX_EVENTS = fx("two-turns.jsonl");
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");

    await runCodex({
      runDir: run.dir,
      name: "worker-M1.L1",
      role: "worker",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: [],
      isolated: true,
    });

    const seen = JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGS!, "utf8"));
    expect(seen.args.slice(0, 2)).toEqual(["exec", "--ignore-user-config"]);
    expect(seen.codexHome).toBe(codexHome());
    expect(codexHome()).not.toBe(userCodexHome());
    expect(lstatSync(join(codexHome(), "auth.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(codexHome(), "auth.json"))).toBe(join(userCodexHome(), "auth.json"));
  });

  test("writes a live marker with the pid while the role runs", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "w").brief, "B");
    process.env.FAKE_CODEX_EVENTS = fx("two-turns.jsonl");
    process.env.FAKE_CODEX_DELAY_MS = "800";
    const pending = runCodex({
      runDir: run.dir,
      name: "w",
      role: "worker",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: [],
    });
    await new Promise((r) => setTimeout(r, 300));
    const live = readLive(run.dir);
    expect(live).toHaveLength(1);
    expect(live[0]?.pid).toBeGreaterThan(0);
    expect(live[0]?.isolated).toBe(false);
    await pending;
  });

  test("resumes a thread with the fix brief and the sandbox passed as -c", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").fix, "FIX TEXT");
    process.env.FAKE_CODEX_EVENTS = fx("two-turns.jsonl");
    process.env.FAKE_CODEX_REPLY = "STATUS: complete — fixed";
    process.env.FAKE_CODEX_ARGS = join(home, "args.json");

    await runCodex({
      runDir: run.dir,
      name: "worker-M1.L1",
      role: "worker",
      rung: "gpt-6-sol#high",
      cwd: repo,
      ownedFiles: [],
      thread: "t-two",
    });

    const seen = JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGS!, "utf8"));
    expect(seen.stdin).toBe("FIX TEXT");
    expect(seen.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(seen.args).toContain("sandbox_mode=workspace-write");
    expect(seen.args.slice(-2)).toEqual(["t-two", "-"]);
  });

  test("keeps the previous round when the same role runs again", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "reviewer-M1").brief, "B");
    process.env.FAKE_CODEX_EVENTS = fx("two-turns.jsonl");
    process.env.FAKE_CODEX_REPLY = "CLEAN\nSTATUS: complete — none";
    const o = {
      runDir: run.dir,
      name: "reviewer-M1",
      role: "reviewer" as const,
      rung: "gpt-6-sol#high",
      cwd: repo,
      ownedFiles: [],
    };
    await runCodex(o);
    await runCodex(o);
    expect(existsSync(join(run.dir, "roles", "reviewer-M1.r1.out"))).toBe(true);
  });

  test("marks a usage limit as limit", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "worker-M1.L1").brief, "B");
    process.env.FAKE_CODEX_EVENTS = fx("limit.jsonl");
    process.env.FAKE_CODEX_EXIT = "1";
    const r = await runCodex({
      runDir: run.dir,
      name: "worker-M1.L1",
      role: "worker",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: [],
    });
    expect(r.status).toBe("limit");
  });

  test("ticks progress while the child runs", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "w").brief, "B");
    process.env.FAKE_CODEX_EVENTS = fx("two-turns.jsonl");
    process.env.FAKE_CODEX_DELAY_MS = "1200";
    const ticks: number[] = [];
    await runCodex({
      runDir: run.dir,
      name: "w",
      role: "worker",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: [],
      onProgress: (p) => ticks.push(p.secs),
    });
    expect(ticks.length).toBeGreaterThan(0);
  });

  test.each([false, true])("collects the images this thread wrote (isolated: %s)", async (isolated) => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(rolePaths(run.dir, "artist-1").brief, "B");
    process.env.FAKE_CODEX_EVENTS = fx("ok-with-reconnect.jsonl");
    process.env.FAKE_CODEX_REPLY = "STATUS: complete — drawn";
    const dir = join(
      isolated ? codexHome() : userCodexHome(),
      "generated_images",
      "01a0d0d4-d0a6-71a1-983c-82a9169200b4",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "img_1.png"), "png");
    const r = await runCodex({
      runDir: run.dir,
      name: "artist-1",
      role: "artist",
      rung: "gpt-6-sol#medium",
      cwd: repo,
      ownedFiles: [],
      isolated,
    });
    expect(r.images).toEqual([join(dir, "img_1.png")]);
  });
});

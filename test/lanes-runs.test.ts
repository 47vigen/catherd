import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendRoute, currentRoute, ownedFilesOf, readLane, type LaneRoute } from "../src/core/lanes.ts";
import { createRun, writeLive } from "../src/core/runstore.ts";
import { backendOf, findRun, refreshState, runFile } from "../src/mcp/runs.ts";
import { loadCatalog } from "../src/routing/catalog.ts";
import { tempRepo, withHome } from "./helpers.ts";

const route = (lane: string, rung: string): LaneRoute => ({
  at: new Date().toISOString(),
  lane,
  role: "worker",
  rung,
  ladder: ["gpt-6-sol#medium", "gpt-6-sol#high"],
  source: "route",
  from: null,
  reason: null,
  kind: "repo_code",
  difficulty: "build",
  jev: "default",
});

describe("lane files", () => {
  beforeEach(() => withHome());

  test("reads the Owns: line in its plain and bold forms", () => {
    expect(ownedFilesOf("# M1.L1 — x\nOwns: src/a.ts, `test/a.test.ts`\nFast check: pnpm t")).toEqual([
      "src/a.ts",
      "test/a.test.ts",
    ]);
    expect(ownedFilesOf("**Owns:** src/b.ts")).toEqual(["src/b.ts"]);
    expect(ownedFilesOf("# no owners here")).toEqual([]);
  });

  test("refuses a lane id that is a path", () => {
    const run = createRun(tempRepo(), "t", []);
    expect(() => readLane(run.dir, "../meta")).toThrow(/bad lane id/);
    expect(() => readLane(run.dir, "M9.L9")).toThrow(/no lane file/);
  });

  test("keeps the last route of a lane as its current one", () => {
    const run = createRun(tempRepo(), "t", []);
    appendRoute(run.dir, route("M1.L1", "gpt-6-sol#medium"));
    appendRoute(run.dir, { ...route("M1.L1", "gpt-6-sol#high"), source: "climb", from: "gpt-6-sol#medium" });
    appendRoute(run.dir, route("M1.L2", "gpt-6-luna#high"));
    expect(currentRoute(run.dir, "M1.L1")?.rung).toBe("gpt-6-sol#high");
    expect(currentRoute(run.dir, "M1.L3")).toBeUndefined();
  });
});

describe("run folder guard", () => {
  beforeEach(() => withHome());

  test("finds a run by id and refuses unknown or path-like ids", () => {
    const run = createRun(tempRepo(), "find me", []);
    expect(findRun(run.id).meta.title).toBe("find me");
    expect(() => findRun("nope")).toThrow(/no run/);
    expect(() => findRun("../x")).toThrow(/bad run id/);
  });

  test("confines paths to the run folder and protects catherd's own files", () => {
    const run = createRun(tempRepo(), "t", []);
    expect(runFile(run, "lanes/M1.L1.md", "write")).toBe(join(run.dir, "lanes", "M1.L1.md"));
    expect(runFile(run, join(run.dir, "plan.md"), "write")).toBe(join(run.dir, "plan.md"));
    expect(() => runFile(run, "../../escape.md", "write")).toThrow(/outside the run folder/);
    expect(() => runFile(run, "/etc/passwd", "read")).toThrow(/outside the run folder/);
    expect(() => runFile(run, "state.md", "write")).toThrow(/written by catherd itself/);
    expect(() => runFile(run, "roles/worker-M1.L1.md", "write")).toThrow(/written by catherd itself/);
    expect(runFile(run, "state.md", "read")).toBe(join(run.dir, "state.md"));
  });

  test("refuses a symlink inside the run folder that points out of it", () => {
    const run = createRun(tempRepo(), "t", []);
    const outside = mkdtempSync(join(tmpdir(), "catherd-out-"));
    symlinkSync(outside, join(run.dir, "lanes", "out"));
    expect(() => runFile(run, "lanes/out/x.md", "write")).toThrow(/resolves outside the run folder/);
  });
});

describe("refreshState", () => {
  beforeEach(() => withHome());

  test("renders HEAD, dirty files with their owners, running roles and the next step", async () => {
    const repo = tempRepo();
    const run = createRun(repo, "t", []);
    writeFileSync(join(repo, "a.ts"), "x");
    writeLive(run.dir, {
      name: "worker-M1.L1",
      role: "worker",
      backend: "codex",
      rung: "gpt-6-sol#medium",
      pid: process.pid,
      thread: null,
      startedAt: "2026-09-24T10:00:00.000Z",
      cwd: repo,
      ownedFiles: ["a.ts"],
      before: {},
      isolated: false,
    });

    await refreshState(run, { next: "review M1" });

    const state = readFileSync(join(run.dir, "state.md"), "utf8");
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(state).toContain(`HEAD ${head}`);
    expect(state).toContain("- a.ts (worker-M1.L1)");
    expect(state).toContain("worker-M1.L1 · gpt-6-sol#medium · thread new · since 10:00");
    expect(state.trimEnd().split("\n").at(-1)).toBe("Next: wait for worker-M1.L1; then review M1");
  });

  test("keeps the recorded next step and last check across rewrites, and shows a role that is starting", async () => {
    const run = createRun(tempRepo(), "t", []);
    await refreshState(run, { next: "land M1", lastCheck: "vitest 12/12" });
    await refreshState(run, {
      starting: {
        name: "reviewer-M1",
        rung: "gpt-6-sol#high",
        thread: null,
        brief: "roles/reviewer-M1.md",
        since: "11:00",
      },
    });
    const state = readFileSync(join(run.dir, "state.md"), "utf8");
    expect(state).toContain("Last check: vitest 12/12");
    expect(state).toContain("reviewer-M1 · gpt-6-sol#high");
    expect(state.trimEnd().split("\n").at(-1)).toBe("Next: wait for reviewer-M1; then land M1");
  });
});

describe("backendOf", () => {
  beforeEach(() => withHome());

  test("reads the backend from the catalog, and treats an unknown provider/model as opencode", () => {
    const c = loadCatalog();
    expect(backendOf(c, "gpt-6-sol#medium")).toBe("codex");
    expect(backendOf(c, "claude-opus-5-5#high")).toBe("claude");
    expect(backendOf(c, "someprovider/some-model#default")).toBe("opencode");
  });
});

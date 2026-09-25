import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { ask, climb, land, route } from "../../src/services/lane-service.ts";
import {
  readKnowledge,
  readRunFile,
  recordAgentRun,
  result,
  setNext,
  startRun,
  writeRunFile,
} from "../../src/services/run-service.ts";
import { appendRecord, findRun, readAgentRuns, readRoutes, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, LADDER, makeRecord, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const codeOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
};
const lastLine = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").at(-1);

function commit(repo: string): string {
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  writeFileSync(join(repo, `f${Math.random()}.txt`), "x");
  git("add", "-A");
  git("commit", "-qm", "m");
  return git("rev-parse", "--short", "HEAD");
}

describe("startRun", () => {
  it("resolves the repo to its git toplevel and writes state.md", async () => {
    withHome();
    const repo = tempRepo();
    mkdirSync(join(repo, "src"));
    const { run, dir } = await startRun(fakeDeps(), {
      repo: join(repo, "src"),
      title: "t",
      aLines: ["A1 x"],
    });
    expect(findRun(run).meta.repo).toBe(repo);
    expect(lastLine(join(dir, "state.md"))).toBe("Next: plan the milestones");
    expect(
      await codeOf(
        startRun(fakeDeps(), { repo: mkdtempSync(join(tmpdir(), "nogit-")), title: "t", aLines: ["A1"] }),
      ),
    ).toBe("E_IO_PATH");
  });
});

describe("route and climb", () => {
  it("routes a lane file and records it, and routes a role without recording", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps();
    const r = await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    expect(r).toMatchObject({
      lane: "M1.L1",
      rung: LADDER[0],
      ladder: LADDER,
      backend: "codex",
      agent: null,
    });
    expect(readRoutes(run)).toMatchObject([
      { lane: "M1.L1", rung: LADDER[0], source: "route", decidedBy: "default" },
    ]);
    const a = await route(deps, { run: run.id, role: "architect" });
    expect(a).toMatchObject({
      lane: null,
      backend: "claude",
      agent: "catherd-architect-claude-opus-5-5-high",
    });
    expect(readRoutes(run)).toHaveLength(1);
  });

  it("refuses a lane file outside lanes/ or missing", async () => {
    const { run } = freshRun();
    writeRunFile({ run: run.id, path: "plan.md", content: "x" });
    expect(await codeOf(route(fakeDeps(), { run: run.id, laneFile: "plan.md", role: "worker" }))).toBe(
      "E_LANE_INVALID",
    );
    expect(await codeOf(route(fakeDeps(), { run: run.id, laneFile: "lanes/M9.md", role: "worker" }))).toBe(
      "E_LANE_INVALID",
    );
  });

  it("climbs one rung per call with the reason, then reports the top", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps();
    expect(await codeOf(climb(deps, { run: run.id, lane: "M1.L1", reason: "refused" }))).toBe(
      "E_LANE_INVALID",
    );
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    const up = await climb(deps, {
      run: run.id,
      lane: "M1.L1",
      reason: "check-failed-twice",
      evidence: "roles/x/stderr",
    });
    expect(up).toEqual({
      lane: "M1.L1",
      rung: LADDER[1] as string,
      top: false,
      backend: "codex",
      agent: null,
    });
    expect(readRoutes(run).at(-1)).toMatchObject({
      source: "climb",
      from: LADDER[0],
      reason: "check-failed-twice: roles/x/stderr",
    });
    expect(lastLine(runPaths(run.dir).state)).toBe(`Next: dispatch M1.L1 at ${LADDER[1]} on a fresh thread`);
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    const top = await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    expect(top).toMatchObject({ rung: LADDER[3], top: true });
  });
});

describe("land", () => {
  it("writes five cells with the minutes since run start, then since the previous landing", async () => {
    const { repo, run } = freshRun("Ship it");
    const start = Date.parse(run.meta.createdAt);
    let now = start + 12 * 60_000;
    const deps = fakeDeps({ now: () => now });
    const c1 = commit(repo);
    const first = await land(deps, {
      run: run.id,
      milestone: "M1",
      what: "login | form",
      commit: c1,
      evidence: "bun test\n12/12",
      next: "M2",
      learned: "the suite takes 4 min",
    });
    expect(first).toEqual({ ledger: `M1 | login / form | ${c1} | 12 | bun test/12/12`, minutes: 12 });
    now += 5 * 60_000;
    const second = await land(deps, {
      run: run.id,
      milestone: "M2",
      what: "logout",
      commit: commit(repo),
      evidence: "ok",
      next: "finish",
    });
    expect(second.minutes).toBe(5);
    const ledger = readFileSync(runPaths(run.dir).ledger, "utf8").trim().split("\n");
    expect(ledger).toHaveLength(3);
    expect(ledger.every((row) => row.split(" | ").length === 5)).toBe(true);
    expect(lastLine(runPaths(run.dir).state)).toBe("Next: finish");
    mkdirSync(join(repo, "sub"));
    expect(await readKnowledge(join(repo, "sub"))).toContain("Ship it M1: the suite takes 4 min");
  });

  it("refuses a commit that is not in the repo", async () => {
    const { run } = freshRun();
    const bad = { run: run.id, milestone: "M1", what: "x", evidence: "x", next: "x" };
    expect(await codeOf(land(fakeDeps(), { ...bad, commit: "deadbeef" }))).toBe("E_RUN_COMMIT");
    expect(await codeOf(land(fakeDeps(), { ...bad, commit: "--all" }))).toBe("E_RUN_COMMIT");
  });
});

/** Puts a fake `git` first on PATH: `git status` exits 128, every other command runs the real git. */
function breakGitStatus(): void {
  const real = Bun.which("git");
  const bin = mkdtempSync(join(tmpdir(), "catherd-fakegit-"));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" status "*) exit 128;; esac\nexec "${real}" "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

describe("a failed state.md refresh", () => {
  it("never fails climb or land: the route and the ledger row are kept, and a hint says so", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    let now = Date.parse(run.meta.createdAt) + 3 * 60_000;
    const deps = fakeDeps({ now: () => now });
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    await setNext({ run: run.id, next: "dispatch M1.L1" });
    const c1 = commit(repo);
    const state = readFileSync(runPaths(run.dir).state, "utf8");
    breakGitStatus();
    const hint = `state.md not refreshed: git status failed in ${repo}`;
    expect(await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" })).toEqual({
      lane: "M1.L1",
      rung: LADDER[1] as string,
      top: false,
      backend: "codex",
      agent: null,
      hints: [hint],
    });
    expect(readRoutes(run).at(-1)).toMatchObject({ source: "climb", rung: LADDER[1] });
    const land1 = { run: run.id, milestone: "M1", what: "x", commit: c1, evidence: "ok", next: "M2" };
    expect(await land(deps, land1)).toEqual({ ledger: `M1 | x | ${c1} | 3 | ok`, minutes: 3, hints: [hint] });
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toBe(state);
    now += 4 * 60_000;
    // the landing time was kept although state.md was not refreshed
    expect(await land(deps, { ...land1, milestone: "M2" })).toMatchObject({ minutes: 4, hints: [hint] });
    expect(readFileSync(runPaths(run.dir).ledger, "utf8").trim().split("\n")).toHaveLength(3);
  });
});

describe("ask", () => {
  it("needs the question's state keys, and reads the lane file it names", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps();
    expect(await codeOf(ask(deps, { run: run.id, question: "finding", state: { finding: "x" } }))).toBe(
      "E_INPUT_INVALID",
    );
    expect(
      await ask(deps, {
        run: run.id,
        question: "finding",
        state: { lane_file: "lanes/M1.L1.md", finding: "BUG a" },
      }),
    ).toMatchObject({ value: "code" });
    expect(
      await ask(deps, { run: run.id, question: "same-defect", state: { before: "a", after: "b" } }),
    ).toMatchObject({ value: "no" });
  });
});

describe("run files, result and agent runs", () => {
  it("writes and reads run files through the guard", async () => {
    const { run } = freshRun();
    writeRunFile({ run: run.id, path: "lanes/M1.L1.md", content: "# M1.L1" });
    expect(readRunFile({ run: run.id, path: "lanes/M1.L1.md" })).toBe("# M1.L1");
    expect(await codeOf(() => writeRunFile({ run: run.id, path: "runs.jsonl", content: "" }))).toBe(
      "E_IO_PATH",
    );
    expect(await codeOf(() => readRunFile({ run: run.id, path: "nope.md" }))).toBe("E_IO_PATH");
    await setNext({ run: run.id, next: "paused: user asked" });
    expect(lastLine(runPaths(run.dir).state)).toBe("Next: paused: user asked");
  });

  it("returns a live role's state, then its record and capped reply", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    const d = await fakeDispatch(run, {}, { proc: "self" });
    expect(result(deps, { run: run.id, name: "worker-M1.L1" })).toMatchObject({
      state: "running",
      record: null,
    });
    writeFileSync(dispatchPaths(d.dir).reply, `${"line\n".repeat(300)}STATUS: complete — ok`);
    await appendRecord(run, makeRecord({ dispatchId: d.admit.dispatchId }));
    const r = result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.state).toBe("finished");
    expect(r.record?.dispatchId).toBe(d.admit.dispatchId);
    expect(r.reply).toContain(`[capped: the full reply is ${r.replyPath}]`);
    expect(await codeOf(() => result(deps, { run: run.id, name: "nobody" }))).toBe("E_RUN_NOT_FOUND");
  });

  it("records a native subagent run, and only for a claude rung", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    const row = recordAgentRun(deps, {
      run: run.id,
      name: "architect",
      role: "architect",
      rung: "claude:claude-opus-5-5#high",
      totalTokens: 42_000,
      durationMs: 61_000,
    });
    expect(row).toMatchObject({
      agent: "catherd-architect-claude-opus-5-5-high",
      totalTokens: 42_000,
      secs: 61,
      status: "ok",
      costUsd: null,
    });
    expect(readAgentRuns(run)).toHaveLength(1);
    expect(
      await codeOf(() =>
        recordAgentRun(deps, {
          run: run.id,
          name: "w",
          role: "worker",
          rung: "codex:gpt-6-sol#high",
          totalTokens: 1,
        }),
      ),
    ).toBe("E_ADMIT_RUNG");
  });
});

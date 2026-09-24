import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { readRoutes } from "../src/core/lanes.ts";
import { tempRepo, withHome } from "./helpers.ts";
import { call, mcpClient, startRun } from "./mcp-helpers.ts";

const LANE = "# M1.L1 — jobs list\nOwns: src/jobs.ts\nFast check: pnpm vitest run test/jobs.test.ts\n";

describe("lane tools", () => {
  beforeEach(() => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
  });

  test("routes a lane to the profile default when Jev is unavailable, and records it", async () => {
    const c = await mcpClient();
    const { run, dir } = await startRun(c, tempRepo());
    await call(c, "write_run_file", { run, path: "lanes/M1.L1.md", content: LANE });
    const r = await call(c, "route", { run, lane_file: "lanes/M1.L1.md" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      lane: "M1.L1",
      role: "worker",
      rung: "gpt-6-sol#medium",
      source: "default",
      backend: "codex",
    });
    expect(r.data.agent).toBeUndefined();
    expect(readRoutes(dir).map((x) => [x.lane, x.rung, x.source])).toEqual([
      ["M1.L1", "gpt-6-sol#medium", "route"],
    ]);
  });

  test("routes a role without a lane file, naming the agent for a Claude rung", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    const r = await call(c, "route", { run, role: "architect" });
    expect(r.data).toMatchObject({
      role: "architect",
      rung: "claude-opus-5-5#high",
      backend: "claude",
      agent: "catherd-architect-claude-opus-5-5-high",
    });
  });

  test("refuses a lane file outside lanes/", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    await call(c, "write_run_file", { run, path: "notes.md", content: LANE });
    const r = await call(c, "route", { run, lane_file: "notes.md" });
    expect(r.isError).toBe(true);
    expect(r.raw).toContain("lanes/<id>.md");
  });

  test("climbs a lane rung by rung, records each reason, and reports the top", async () => {
    const c = await mcpClient();
    const { run, dir } = await startRun(c, tempRepo());
    await call(c, "write_run_file", { run, path: "lanes/M1.L1.md", content: LANE });
    await call(c, "route", { run, lane_file: "lanes/M1.L1.md" });

    const one = await call(c, "climb", { run, lane: "M1.L1", reason: "unchanged" });
    expect(one.data).toMatchObject({ rung: "gpt-6-sol#high", top: false, backend: "codex" });
    const state = readFileSync(join(dir, "state.md"), "utf8").trimEnd().split("\n").at(-1);
    expect(state).toBe("Next: dispatch M1.L1 at gpt-6-sol#high on a fresh thread");

    const two = await call(c, "climb", {
      run,
      lane: "M1.L1",
      reason: "blocker",
      evidence: "roles/reviewer-M1.out",
    });
    expect(two.data.rung).toBe("gpt-6-sol#xhigh");
    const top = await call(c, "climb", { run, lane: "M1.L1", reason: "check-failed-twice" });
    expect(top.data).toMatchObject({ rung: "gpt-6-sol#xhigh", top: true });

    const climbs = readRoutes(dir).filter((x) => x.source === "climb");
    expect(climbs.map((x) => [x.from, x.reason])).toEqual([
      ["gpt-6-sol#medium", "unchanged"],
      ["gpt-6-sol#high", "blocker: roles/reviewer-M1.out"],
      ["gpt-6-sol#xhigh", "check-failed-twice"],
    ]);
  });

  test("refuses to climb a lane that was never routed, or with an unknown reason", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    expect((await call(c, "climb", { run, lane: "M9.L9", reason: "blocker" })).raw).toContain("never routed");
    expect((await call(c, "climb", { run, lane: "M1.L1", reason: "felt like it" })).isError).toBe(true);
  });

  test("asks same-defect and finding, falling back to the defaults without Jev", async () => {
    const c = await mcpClient();
    const { run } = await startRun(c, tempRepo());
    await call(c, "write_run_file", { run, path: "lanes/M1.L1.md", content: LANE });
    const same = await call(c, "ask", {
      run,
      question: "same-defect",
      state: { before: "BUG a.ts:3 x", after: "BUG a.ts:4 x" },
    });
    expect(same.data).toMatchObject({ value: "no", source: "default" });
    const finding = await call(c, "ask", {
      run,
      question: "finding",
      state: { lane_file: "lanes/M1.L1.md", finding: "BUG src/jobs.ts:9 — off by one" },
    });
    expect(finding.data).toMatchObject({ value: "code", source: "default" });
    const missing = await call(c, "ask", { run, question: "same-defect", state: { before: "x" } });
    expect(missing.raw).toContain("needs state.after");
  });

  test("lands a milestone: ledger row, last check and next step", async () => {
    const c = await mcpClient();
    const repo = tempRepo();
    const { run, dir } = await startRun(c, repo);
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const r = await call(c, "land", {
      run,
      milestone: "M1",
      what: "jobs list | paged",
      commit: head,
      evidence: "vitest 12/12",
      next: "start M2 lanes",
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, "ledger.md"), "utf8")).toContain(
      `M1 | jobs list / paged | ${head} | vitest 12/12`,
    );
    const state = readFileSync(join(dir, "state.md"), "utf8");
    expect(state).toContain("Last check: vitest 12/12");
    expect(state.trimEnd().split("\n").at(-1)).toBe("Next: start M2 lanes");
    const bad = await call(c, "land", {
      run,
      milestone: "M2",
      what: "x",
      commit: "deadbee",
      evidence: "x",
      next: "x",
    });
    expect(bad.isError).toBe(true);
    expect(bad.raw).toContain("no commit deadbee");
  });

  test("land appends what the run learned to the repo's knowledge.md, read back by read_knowledge (v1)", async () => {
    const c = await mcpClient();
    // run_start resolves the repo to git's toplevel (e.g. through a symlinked tmp dir on macOS);
    // read_knowledge is keyed by that same resolved path.
    const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: tempRepo(),
      encoding: "utf8",
    }).trim();
    const { run } = await startRun(c, repo, "Jobs screen");
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    expect((await call(c, "read_knowledge", { repo })).raw).toContain("no knowledge recorded yet");

    await call(c, "land", {
      run,
      milestone: "M1",
      what: "jobs list",
      commit: head,
      evidence: "vitest 12/12",
      next: "start M2",
      learned: "the jobs API paginates by cursor, not offset",
    });
    const knowledge = (await call(c, "read_knowledge", { repo })).raw;
    expect(knowledge).toContain("Jobs screen");
    expect(knowledge).toContain("M1");
    expect(knowledge).toContain("the jobs API paginates by cursor, not offset");

    // a second landing with nothing new appends nothing further
    await call(c, "land", { run, milestone: "M2", what: "x", commit: head, evidence: "x", next: "x" });
    expect((await call(c, "read_knowledge", { repo })).raw).toBe(knowledge);
  });
});

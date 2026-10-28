import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { writeRunFile } from "../../src/services/run-service.ts";
import {
  checkLogs,
  commitDiff,
  dispatchDetail,
  dispatchDir,
  runDoc,
  runShas,
} from "../../src/services/run-files.ts";
import { appendRecord, appendRoute, createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { makeRecord } from "../domain/make-record.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const T0 = new Date("2026-10-21T10:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const started: RunEventInput = {
  type: "run.started",
  repo: "/r",
  title: "t",
  aLines: [],
  plan: [],
  base: null,
};
const dStarted = (dispatchId: string): RunEventInput => ({
  type: "dispatch.started",
  dispatchId,
  name: "worker-M1.L1",
  role: "worker",
  unit: "M1.L1",
  lane: "M1.L1",
  rung: "codex:gpt-6-sol#high",
  thread: null,
});
const dEnded = (dispatchId: string, head: string | null = null): RunEventInput => ({
  type: "dispatch.ended",
  dispatchId,
  name: "worker-M1.L1",
  unit: "M1.L1",
  status: "ok",
  replyStatus: "complete",
  reason: null,
  why: "all done",
  thread: null,
  head,
  environment: null,
  verdict: null,
  findings: [{ label: "BUG", text: "BUG off by one", file: "src/a/x.ts" }],
  replyPath: "reply.md",
});

const D1 = "d-20261021-100000-aaaaaa";

async function runWithDispatch(): Promise<Run> {
  const { run } = freshRun();
  await appendEvent(run, started, T0);
  await appendEvent(run, dStarted(D1), at(2));
  await appendEvent(run, dEnded(D1), at(5));
  await appendRecord(
    run,
    makeRecord({ runId: run.id, dispatchId: D1, name: "worker-M1.L1", lane: "M1.L1", attempt: 2 }),
  );
  appendRoute(run, {
    at: at(1).toISOString(),
    lane: "M1.L1",
    role: "worker",
    rung: "codex:gpt-6-sol#high",
    ladder: ["codex:gpt-6-luna#high", "codex:gpt-6-sol#high"],
    source: "route",
    decidedBy: "lane",
    from: null,
    reason: null,
    kind: null,
    difficulty: null,
    why: "the lane asked for build",
  });
  return run;
}

function writeDispatchFiles(run: Run, files: Record<string, string>): void {
  const dir = dispatchDir(run, D1);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
}

describe("a dispatch's files", () => {
  it("a dispatch's detail carries its record, route, brief, reply, findings and A-lines", async () => {
    const run = await runWithDispatch();
    writeDispatchFiles(run, {
      "brief.md": "do the thing",
      "reply.md": "A1 PASS bun test\nA2 FAIL no output\nSTATUS: complete — ok",
      stderr: "warn",
    });
    const d = dispatchDetail(run, D1);
    expect(d).toMatchObject({
      dispatchId: D1,
      name: "worker-M1.L1",
      role: "worker",
      unit: "M1.L1",
      lane: "M1.L1",
      rung: "codex:gpt-6-sol#high",
      startedAt: at(2).toISOString(),
      endedAt: at(5).toISOString(),
      status: "ok",
      replyStatus: "complete",
      why: "all done",
      brief: "do the thing",
      stderr: "warn",
      truncated: [],
    });
    expect(d.record).toMatchObject({ attempt: 2, failoverFrom: null, isolated: false });
    expect(d.route).toEqual({
      source: "route",
      decidedBy: "lane",
      why: "the lane asked for build",
      ladder: ["codex:gpt-6-luna#high", "codex:gpt-6-sol#high"],
    });
    expect(d.findings).toEqual([{ label: "BUG", text: "BUG off by one", file: "src/a/x.ts" }]);
    expect(d.aLines).toEqual([
      { id: "A1", pass: true, text: "bun test" },
      { id: "A2", pass: false, text: "no output" },
    ]);
  });

  it("a dispatch with no folder gives its detail with no texts", async () => {
    const run = await runWithDispatch();
    const d = dispatchDetail(run, D1);
    expect([d.brief, d.reply, d.stderr]).toEqual([null, null, null]);
    expect(d.aLines).toEqual([]);
  });

  it("a text over 512 KB is cut and named", async () => {
    const run = await runWithDispatch();
    writeDispatchFiles(run, { "reply.md": "x".repeat(512 * 1024 + 10) });
    const d = dispatchDetail(run, D1);
    expect(d.truncated).toEqual(["reply"]);
    expect(d.reply?.length).toBe(512 * 1024);
  });

  it("an unknown dispatch is refused", async () => {
    const run = await runWithDispatch();
    expect(() => dispatchDetail(run, "d-nope")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(() => dispatchDir(run, "../x")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });
});

describe("run docs", () => {
  it("serves plan, report, ledger, a lane and a digest, and refuses any other name", () => {
    const { run } = freshRun();
    const p = runPaths(run.dir);
    mkdirSync(p.lanes, { recursive: true });
    mkdirSync(join(run.dir, "digests"), { recursive: true });
    writeFileSync(p.plan, "# plan");
    writeFileSync(p.ledger, "ledger");
    writeFileSync(join(p.lanes, "M1.L1.md"), "lane");
    writeFileSync(join(run.dir, "digests", "M1.md"), "digest");
    expect(runDoc(run, "plan.md")).toEqual({ name: "plan.md", text: "# plan", cut: false });
    expect(runDoc(run, "ledger.md").text).toBe("ledger");
    expect(runDoc(run, "lanes/M1.L1.md").text).toBe("lane");
    expect(runDoc(run, "digests/M1.md").text).toBe("digest");
    for (const bad of ["../meta.json", "lanes/../x.md", "runs.jsonl", "lanes/a/b.md", "/etc/passwd"])
      expect(() => runDoc(run, bad)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(() => runDoc(run, "report.md")).toThrow(
      expect.objectContaining({ code: "E_RUN_NOT_FOUND", message: expect.stringContaining("report.md") }),
    );
  });

  it("a cut document says so and never ends inside a UTF-8 character", () => {
    const { run } = freshRun();
    const text = "x".repeat(512 * 1024 - 1);
    writeFileSync(runPaths(run.dir).plan, `${text}émore`);
    expect(runDoc(run, "plan.md")).toEqual({ name: "plan.md", text, cut: true });
  });

  it("reads a document up to the text cap, and a name that is not a file is not found", () => {
    const { run } = freshRun();
    writeFileSync(runPaths(run.dir).plan, "x".repeat(512 * 1024 + 10));
    expect(runDoc(run, "plan.md").text).toHaveLength(512 * 1024);
    mkdirSync(join(run.dir, "digests", "M1.md"), { recursive: true });
    expect(() => runDoc(run, "digests/M1.md")).toThrow(expect.objectContaining({ code: "E_RUN_NOT_FOUND" }));
  });
});

describe("check logs", () => {
  it("a log's tail never starts inside a UTF-8 character", async () => {
    const run = await runWithDispatch();
    const dir = join(runPaths(run.dir).scratch, "worker-M1.L1");
    mkdirSync(dir, { recursive: true });
    const text = "y".repeat(64 * 1024 - 1);
    writeFileSync(join(dir, "full-check.log"), `é${text}`);
    expect(checkLogs(run, "M1.L1").full).toBe(text);
  });

  it("reads a lane's fast and full check logs", async () => {
    const run = await runWithDispatch();
    const dir = join(runPaths(run.dir).scratch, "worker-M1.L1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fast-check.log"), "fast ok");
    writeFileSync(join(dir, "full-check.log"), `${"y".repeat(70 * 1024)}END`);
    const c = checkLogs(run, "M1.L1");
    expect(c).toMatchObject({ lane: "M1.L1", name: "worker-M1.L1", fast: "fast ok", exit: null });
    expect(c.full?.length).toBe(64 * 1024);
    expect(c.full?.endsWith("END")).toBe(true);
    expect(() => checkLogs(run, "M9.L9")).toThrow(expect.objectContaining({ code: "E_RUN_NOT_FOUND" }));
    expect(() => checkLogs(run, "../x")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });
});

function commit(repo: string, files: Record<string, string>, msg: string): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  const run = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo }).toString();
  run("add", "-A");
  run("commit", "-q", "-m", msg);
  return run("rev-parse", "HEAD").trim();
}

describe("commit diffs", () => {
  it("diffs a commit a role ended on, and refuses any other sha or a lane (plan 48: no lanes)", async () => {
    const run = await runWithDispatch();
    const repo = run.meta.repo;
    const a = commit(repo, { "src/a/x.ts": "one\n", "src/b/y.ts": "two\n" }, "first");
    const b = commit(repo, { "src/a/z.ts": "three\n" }, "second");
    await appendEvent(run, dEnded(D1, a), at(8));
    expect(runShas(run)).toEqual([a]);
    const all = await commitDiff(run, a);
    expect(all).toMatchObject({ sha: a, truncated: false, paths: null });
    expect(all.text).toContain("src/b/y.ts");
    expect((await commitDiff(run, a.slice(0, 8))).sha).toBe(a);
    for (const bad of [b, b.slice(0, 8), "abc", "--output=x", a.slice(0, 6)])
      expect(commitDiff(run, bad)).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
    expect(commitDiff(run, a, { lane: "M1.L1" })).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
  });

  it("a diff over 1 MB is cut and says so", async () => {
    const run = await runWithDispatch();
    const sha = commit(run.meta.repo, { "big.lock": "line of text\n".repeat(120_000) }, "lockfile");
    await appendEvent(run, dEnded(D1, sha), at(8));
    const d = await commitDiff(run, sha);
    expect(d.truncated).toBe(true);
    expect(d.text.length).toBe(1024 * 1024);
  });
});

describe("lane files", () => {
  it("a lane file may restate an A-line: the architect writes what it needs", () => {
    const { repo } = freshRun();
    const run = createRun({
      repo,
      title: "restate",
      aLines: ["A1 [worker] — the panel boots in a browser and every screen renders without console errors"],
      version: "0.0.0-test",
    });
    const lane = (extra: string) =>
      `# M1.L1 — x\nOwns: src/a/\nKind: repo_code\nDifficulty: build\n${extra}\n`;
    const restating = lane("- the panel boots in a browser and every screen renders");
    expect(writeRunFile({ run: run.id, path: "lanes/M1.L1.md", content: restating }).bytes).toBeGreaterThan(
      0,
    );
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newDispatchId } from "../../src/domain/ids.ts";
import { gateCheck, gatePass } from "../../src/services/gate-service.ts";
import { climb, land, route } from "../../src/services/lane-service.ts";
import { PROTOCOL_CHECKLIST, protocolNext } from "../../src/services/protocol.ts";
import { park } from "../../src/services/questions.ts";
import { startRun } from "../../src/services/run-service.ts";
import { appendAgentRun, appendRecord, findRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord, passGate, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const head = (repo: string) =>
  execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const stateLast = (run: Run) => readFileSync(runPaths(run.dir).state, "utf8").trimEnd().split("\n").at(-1);
const worked = (run: Run, lane: string) =>
  appendAgentRun(run, {
    at: new Date().toISOString(),
    name: `worker-${lane}`,
    role: "worker",
    rung: "claude:claude-opus-5-5#low",
    agent: null,
    totalTokens: 1000,
    costUsd: null,
    secs: 60,
    status: "ok",
    lane,
  });

describe("Protocol next (spec 1.1 §10)", () => {
  it("walks the milestone loop from plan to finish", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    expect(protocolNext(run, [])).toStartWith("plan: the architect writes plan.md");
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M1.L2", ["src/b.ts"]);
    writeLane(run, "M2.L1", ["src/c.ts"]);
    expect(protocolNext(run, [])).toBe("route and preflight M1's lanes");
    for (const l of ["M1.L1", "M1.L2"])
      await route(deps, { run: run.id, laneFile: `lanes/${l}.md`, role: "worker" });
    expect(protocolNext(run, [])).toBe("dispatch M1.L1, M1.L2");
    worked(run, "M1.L1");
    const live = await fakeDispatch(run, { name: "worker-M1.L2", lane: "M1.L2" }, { proc: "self" });
    expect(protocolNext(run, [])).toBe("M1: lanes running (worker-M1.L2)");
    await appendRecord(
      run,
      makeRecord({ runId: run.id, dispatchId: live.admit.dispatchId, name: "worker-M1.L2" }),
    );
    expect(protocolNext(run, [])).toBe("M1: reviewer");
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "reviewer-M1",
        role: "reviewer",
        lane: null,
        endedAt: new Date().toISOString(),
      }),
    );
    expect(protocolNext(run, [])).toBe("M1: verifier");
    await passGate(run, "M1");
    expect(protocolNext(run, [])).toBe("land M1");
    await land(deps, {
      run: run.id,
      milestone: "M1",
      what: "w",
      commit: head(repo),
      evidence: "ok",
      next: "M2",
    });
    expect(protocolNext(run, [])).toBe("route and preflight M2's lanes");
    expect(stateLast(run)).toBe("Protocol next: route and preflight M2's lanes");
    await park(deps, { run: run.id, milestone: "M2", question: "q" });
    expect(stateLast(run)).toBe("Protocol next: M2 parked: wait for the owner");
    expect(protocolNext(run, [])).toBe("route and preflight M2's lanes");
  });

  it("says finish once every milestone landed", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await passGate(run, "M1");
    await land(fakeDeps(), {
      run: run.id,
      milestone: "M1",
      what: "w",
      commit: head(repo),
      evidence: "ok",
      next: "x",
    });
    expect(protocolNext(run, [])).toBe("finish: the final gate, then the report");
  });

  it("run_start returns the step and the six-line checklist", async () => {
    withHome();
    const r = await startRun(fakeDeps(), { repo: tempRepo(), title: "t", aLines: ["A1 x"] });
    expect(r.protocol.next).toStartWith("plan: ");
    expect(r.protocol.checklist).toEqual(PROTOCOL_CHECKLIST);
    expect(PROTOCOL_CHECKLIST).toHaveLength(6);
  });
});

describe("the milestone digest (spec 1.1 §10)", () => {
  it("writes the A-lines, the commit, the lanes with climbs, the review, the verdict with carried items, minutes and tokens", async () => {
    withHome();
    const repo = tempRepo();
    const deps = fakeDeps();
    const started = await startRun(deps, { repo, title: "t", aLines: ["A1 login works", "A2 logout works"] });
    const r = findRun(started.run);
    writeLane(r, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: r.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    await climb(deps, { run: r.id, lane: "M1.L1", reason: "check-failed-twice" });
    // the gate's own records first: the digest reads the latest reviewer's reply
    await passGate(r, "M1");
    const dispatchId = newDispatchId();
    const reply = join("roles", "reviewer-M1", dispatchId, "reply.md");
    mkdirSync(join(r.dir, "roles", "reviewer-M1", dispatchId), { recursive: true });
    writeFileSync(
      join(r.dir, reply),
      "BUG src/a.ts:3 — x — y\n- NIT src/a.ts:9 — x — y\nSTATUS: complete — ok\n",
    );
    await appendRecord(
      r,
      makeRecord({
        runId: r.id,
        dispatchId,
        name: "reviewer-M1",
        role: "reviewer",
        lane: null,
        replyPath: reply,
        endedAt: new Date().toISOString(),
        tokens: { input: 2000, cached: 0, output: 100 },
      }),
    );
    await gatePass(deps, {
      run: r.id,
      item: "unit tests",
      command: "bun test",
      paths: ["."],
      evidence: "ok",
    });
    await gateCheck(deps, { run: r.id, item: "unit tests", command: "bun test", paths: ["."] });
    const landed = await land(deps, {
      run: r.id,
      milestone: "M1",
      what: "login (A1)",
      commit: head(repo),
      evidence: "A1 PASS",
      next: "M2",
    });
    expect(landed.digest).toBe("digests/M1.md");
    const text = readFileSync(join(r.dir, landed.digest), "utf8").split("\n");
    expect(text[0]).toBe("# M1 — login (A1)");
    expect(text[2]).toStartWith(`Commit ${head(repo)} · `);
    expect(text).toContain("A-lines: A1 login works");
    expect(text).toContain(
      "- M1.L1 · codex:gpt-6-luna#high → codex:gpt-6-sol#medium · climbs: check-failed-twice",
    );
    expect(text).toContain("Reviewer: reviewer-M1 · 2 finding(s): 0 BLOCKER, 1 BUG, 1 NIT");
    expect(text.find((l) => l.startsWith("Verifier: "))).toMatch(
      /^Verifier: PASS \(verifier-M1\) · carried: unit tests from [0-9a-f]+$/,
    );
    expect(text.find((l) => l.startsWith("Tokens: "))).toBe(
      "Tokens: 2k in (0 cached) · 100 out · Claude subagents 0 (reported)",
    );
  });
});

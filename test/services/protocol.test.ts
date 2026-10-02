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

  it("sends a lane back to dispatch after a climb, or when its latest dispatch did not end ok", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M1.L2", ["src/b.ts"]);
    for (const l of ["M1.L1", "M1.L2"])
      await route(deps, { run: run.id, laneFile: `lanes/${l}.md`, role: "worker" });
    worked(run, "M1.L1");
    const d = await fakeDispatch(run, { name: "worker-M1.L2", lane: "M1.L2" });
    await appendRecord(
      run,
      makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId, name: "worker-M1.L2", status: "limit" }),
    );
    expect(protocolNext(run, [])).toBe("dispatch M1.L2");
    // a climb after the lane's first dispatch: the lane runs again, at the next rung
    await climb(fakeDeps({ now: () => Date.now() + 1000 }), {
      run: run.id,
      lane: "M1.L1",
      reason: "check-failed-twice",
    });
    expect(protocolNext(run, [])).toBe("dispatch M1.L1, M1.L2");
    const blocked = await fakeDispatch(run, { name: "worker-M1.L2", lane: "M1.L2" });
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: blocked.admit.dispatchId,
        name: "worker-M1.L2",
        replyStatus: "blocked",
      }),
    );
    expect(protocolNext(run, [])).toBe("dispatch M1.L1, M1.L2");
  });

  it("says a lane climbed past its top rung is out of rungs, not dispatch (spec 1.1 §9, §10)", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M1.L2", ["src/b.ts"]);
    let t = Date.now();
    const at = () => fakeDeps({ now: () => (t += 1000) });
    for (const l of ["M1.L1", "M1.L2"])
      await route(at(), { run: run.id, laneFile: `lanes/${l}.md`, role: "worker" });
    worked(run, "M1.L2");
    let top = false;
    while (!top) top = (await climb(at(), { run: run.id, lane: "M1.L1", reason: "check-failed-twice" })).top;
    expect(protocolNext(run, [])).toBe("M1.L1: out of rungs — ask finding, then the architect or park M1");
    // a try at the top rung that ends ok after all: the lane is done
    appendAgentRun(run, {
      at: new Date((t += 1000)).toISOString(),
      name: "worker-M1.L1",
      role: "worker",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 1,
      costUsd: null,
      secs: 1,
      status: "ok",
      lane: "M1.L1",
    });
    expect(protocolNext(run, [])).toBe("M1: reviewer");
    // a plain re-route after an ok try (e.g. an architect delta re-read) keeps the lane done
    await route(at(), { run: run.id, laneFile: "lanes/M1.L2.md", role: "worker" });
    expect(protocolNext(run, [])).toBe("M1: reviewer");
  });

  it("keeps a lane back until the lanes its After: line names have finished ok", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["kit/"]);
    writeLane(run, "M1.L2", ["web/"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M1.L1\n");
    writeLane(run, "M1.L3", ["api/"]);
    for (const l of ["M1.L1", "M1.L2", "M1.L3"])
      await route(deps, { run: run.id, laneFile: `lanes/${l}.md`, role: "worker" });
    expect(protocolNext(run, [])).toBe("dispatch M1.L1, M1.L3; then M1.L2 after M1.L1");
    worked(run, "M1.L3");
    const kit = await fakeDispatch(run, { name: "worker-M1.L1", lane: "M1.L1" }, { proc: "self" });
    expect(protocolNext(run, [])).toBe("M1: lanes running (worker-M1.L1); then M1.L2 after M1.L1");
    await appendRecord(
      run,
      makeRecord({ runId: run.id, dispatchId: kit.admit.dispatchId, name: "worker-M1.L1", status: "failed" }),
    );
    expect(protocolNext(run, [])).toBe("dispatch M1.L1; then M1.L2 after M1.L1");
    worked(run, "M1.L1");
    expect(protocolNext(run, [])).toBe("dispatch M1.L2");
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

  it("after a verifier FAIL names a fresh verifier and the failed items, not a resume (plan 23)", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    worked(run, "M1.L1");
    const at = new Date(Date.now() + 1000).toISOString();
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "reviewer-M1",
        role: "reviewer",
        lane: null,
        endedAt: at,
      }),
    );
    const check = (item: string) => ({
      run: run.id,
      item,
      command: `run ${item}`,
      paths: ["."],
      milestone: "M1",
    });
    await gateCheck(deps, check("lint"));
    await gatePass(deps, { ...check("lint"), evidence: "ok" });
    await gateCheck(deps, check("acceptance"));
    appendAgentRun(run, {
      at: new Date(Date.now() + 2000).toISOString(),
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 0,
      costUsd: null,
      secs: null,
      status: "failed",
    });
    expect(protocolNext(run, [])).toBe(
      "M1: verifier-M1 failed: the owning lanes fix it, then a fresh verifier (not a resume) re-checks acceptance, each command capped at 10 min",
    );
  });

  it("refuses a partial review, and names the fix round while BLOCKER or BUG lines are open (plan 23)", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    worked(run, "M1.L1");
    const t0 = Date.now() + 1000;
    const reviewer = async (name: string, reply: string, status: "complete" | "partial", at: number) => {
      const dispatchId = newDispatchId();
      const replyPath = `roles/${name}/${dispatchId}/reply.md`;
      mkdirSync(join(run.dir, "roles", name, dispatchId), { recursive: true });
      writeFileSync(join(run.dir, replyPath), reply);
      await appendRecord(
        run,
        makeRecord({
          runId: run.id,
          dispatchId,
          name,
          role: "reviewer",
          lane: null,
          replyPath,
          replyStatus: status,
          endedAt: new Date(at).toISOString(),
        }),
      );
    };
    await reviewer("reviewer-M1", "read the core only\nSTATUS: partial — 4 files unread", "partial", t0);
    expect(protocolNext(run, [])).toBe(
      "M1: reviewer-M1 stopped partial: a scoped second pass (reviewer-M1-2) over the files it did not read",
    );
    appendAgentRun(run, {
      at: new Date(t0 + 500).toISOString(),
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 0,
      costUsd: null,
      secs: null,
      status: "ok",
    });
    const e = await land(deps, {
      run: run.id,
      milestone: "M1",
      what: "w",
      commit: head(repo),
      evidence: "ok",
      next: "M2",
    }).then(
      () => null,
      (x: unknown) => x as { code: string; message: string },
    );
    expect(e?.code).toBe("E_LAND_GATE");
    expect(e?.message).toBe(
      "land M1: reviewer-M1 replied STATUS: partial, which is not the milestone's review",
    );
    await reviewer(
      "reviewer-M1-2",
      "- BLOCKER src/a.ts:3 — wrong sign — flip it\n- BUG src/a.ts:9 — off by one — <=\n- NIT src/a.ts:1 — name\nSTATUS: complete — 3 findings",
      "complete",
      t0 + 1000,
    );
    expect(protocolNext(run, [])).toBe(
      "M1: fix round for reviewer-M1-2's findings (1 BLOCKER, 1 BUG), then the verifier",
    );
    // the fix round ends ok after the review: the next step moves on
    appendAgentRun(run, {
      at: new Date(t0 + 2000).toISOString(),
      name: "worker-M1.L1",
      role: "worker",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 1,
      costUsd: null,
      secs: 1,
      status: "ok",
      lane: "M1.L1",
    });
    expect(protocolNext(run, [])).not.toStartWith("M1: fix round");
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
    // spec 1.5: the commits, the review's BLOCKER and BUG lines, and what is still open
    expect(text).toContain(`Commits: ${head(repo)} init`);
    expect(text).toContain("Findings: BUG src/a.ts:3 — x — y");
    expect(text).toContain("Open: none");
    expect(landed.digestPath).toBe(join(r.dir, "digests", "M1.md"));
    expect(text.find((l) => l.startsWith("Verifier: "))).toMatch(
      /^Verifier: PASS \(verifier-M1\) · carried: unit tests from [0-9a-f]+$/,
    );
    expect(text.find((l) => l.startsWith("Tokens: "))).toBe(
      "Tokens: 2k in (0 cached) · 100 out · Claude subagents 0 (reported)",
    );
  });

  it("lists only the milestone's own carried items when the verifier names milestones in gate_check", async () => {
    withHome();
    const repo = tempRepo();
    const deps = fakeDeps();
    const r = findRun((await startRun(deps, { repo, title: "t", aLines: ["A1 x"] })).run);
    writeLane(r, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: r.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    await passGate(r, "M1");
    const gate = (item: string, command: string) => ({ run: r.id, item, command, paths: ["."] });
    await gatePass(deps, { ...gate("lint", "bun run lint"), evidence: "ok" });
    await gatePass(deps, { ...gate("unit tests", "bun test"), evidence: "ok" });
    // M1 is parked; M2's verifier carries its item; then M1 lands
    await gateCheck(deps, { ...gate("lint", "bun run lint"), milestone: "M1" });
    await gateCheck(deps, { ...gate("unit tests", "bun test"), milestone: "M2" });
    const landed = await land(deps, {
      run: r.id,
      milestone: "M1",
      what: "x (A1)",
      commit: head(repo),
      evidence: "A1 PASS",
      next: "M2",
    });
    const verifier = readFileSync(join(r.dir, landed.digest), "utf8")
      .split("\n")
      .find((l) => l.startsWith("Verifier: "));
    expect(verifier).toMatch(/^Verifier: PASS \(verifier-M1\) · carried: lint from [0-9a-f]+$/);
  });
});

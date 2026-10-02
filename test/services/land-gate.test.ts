import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { newDispatchId } from "../../src/domain/ids.ts";
import { land, route } from "../../src/services/lane-service.ts";
import {
  isDocPath,
  isSourcePath,
  namesMilestone,
  reviewerPassed,
  reviewsMilestone,
} from "../../src/services/milestones.ts";
import { protocolNext } from "../../src/services/protocol.ts";
import { appendAgentRun, appendRecord, findRun, readAgentRuns } from "../../src/services/run-store.ts";
import { writeDeliveryAttempt } from "../../src/infra/delivery.ts";
import { result, recordAgentRun, startRun } from "../../src/services/run-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord, passGate, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

/** Writes `files` in the repo and commits them; returns the commit's hash. */
function commitFiles(repo: string, files: string[]): string {
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), `${f} ${Math.random()}\n`);
  }
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t" } });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
  return git("rev-parse", "--short", "HEAD").trim();
}

async function refusal(p: Promise<unknown>): Promise<CatherdError> {
  try {
    await p;
  } catch (e) {
    if (isCatherdError(e)) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

const landing = (run: string, commit: string, over: Record<string, unknown> = {}) => ({
  run,
  milestone: "M1",
  what: "w",
  commit,
  evidence: "ok",
  next: "M2",
  ...over,
});

describe("the land gate (spec 1.1 §6)", () => {
  it("non-Claude and conflicted callers cannot fabricate native verifier accounting or land authority", async () => {
    const { repo, run } = freshRun();
    const commit = commitFiles(repo, ["src/a.ts"]);
    for (const host of [
      { host: "codex" as const, session: null, conflict: null },
      { host: "unknown" as const, session: null, conflict: null },
      { host: "claude-code" as const, session: null, conflict: "Conflicting host identities" },
    ]) {
      for (const role of ["reviewer", "verifier"] as const) {
        expect(() =>
          recordAgentRun(fakeDeps({ host }), {
            run: run.id,
            name: `${role}-M1`,
            role,
            rung: "claude:claude-opus-5-5#high",
            totalTokens: 1,
            status: "ok",
          }),
        ).toThrow("native Claude subagents require");
        expect(readAgentRuns(run)).toEqual([]);
      }
      expect((await refusal(land(fakeDeps({ host }), landing(run.id, commit)))).code).toBe("E_LAND_GATE");
    }
  });
  it("accepted/ambiguous queue inputs and repeated result reads cannot supply reviewer or verifier authority", async () => {
    const { repo, run } = freshRun();
    const d = await fakeDispatch(run, { name: "worker-M1.L1" }, { collect: true });
    await appendRecord(
      run,
      makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId, name: d.admit.name, role: "worker" }),
    );
    const target = {
      host: "codex" as const,
      sessionId: "0199c011-1234-7000-8000-000000000001",
      hostSessionId: null,
      name: null,
    };
    for (const status of ["accepted", "ambiguous"] as const)
      writeDeliveryAttempt(d.dir, {
        attemptId: status,
        target,
        eventIds: [JSON.stringify([run.id, d.admit.dispatchId, "finished"])],
        at: new Date().toISOString(),
        status,
        msgId: status === "accepted" ? "queue-receipt" : null,
        reason: null,
      });
    const commit = commitFiles(repo, ["src/a.ts"]);
    for (let i = 0; i < 2; i++) {
      await result(fakeDeps(), { run: run.id, name: d.admit.name });
      expect((await refusal(land(fakeDeps(), landing(run.id, commit)))).code).toBe("E_LAND_GATE");
    }
    expect(readFileSync(join(run.dir, "ledger.md"), "utf8")).not.toContain("M1 |");
  });
  it("refuses a milestone with no reviewer record and no verifier verdict, naming both", async () => {
    const { repo, run } = freshRun();
    const e = await refusal(land(fakeDeps(), landing(run.id, commitFiles(repo, ["src/a.ts"]))));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toBe(
      "land M1: missing a reviewer record (a dispatch named reviewer-M1, or record_agent_run with role reviewer and that name, status ok) and a verifier verdict (record_agent_run with role verifier named exactly verifier-M1, status ok; a headless verifier-M1's reply opening VERDICT: PASS), since its lanes started",
    );
    expect(e.fix).toContain('record_agent_run(name: "verifier-M1")');
  });

  it("refuses a milestone that is not an id before writing anything (the digest is named after it)", async () => {
    const { repo, run } = freshRun();
    const c = commitFiles(repo, ["README.md"]);
    const ledger = readFileSync(join(run.dir, "ledger.md"), "utf8");
    for (const milestone of ["../state", "M1/a", "../../x"]) {
      const e = await refusal(land(fakeDeps(), landing(run.id, c, { milestone, skip: "no-code" })));
      expect(e.code).toBe("E_ADMIT_ID");
      expect(e.fix).toBeTruthy();
    }
    expect(readFileSync(join(run.dir, "ledger.md"), "utf8")).toBe(ledger);
    expect(existsSync(join(dirname(run.dir), "x.md"))).toBe(false);
  });

  it("lands once both exist, and names only what is still missing", async () => {
    const { repo, run } = freshRun();
    const c = commitFiles(repo, ["src/a.ts"]);
    appendAgentRun(run, {
      at: new Date().toISOString(),
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 5,
      costUsd: null,
      secs: null,
      status: "ok",
      lane: null,
    });
    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(e.message).toStartWith("land M1: missing a reviewer record");
    expect(e.message).not.toContain("verifier verdict");
    await passGate(run, "M1");
    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 | w |");
  });

  it("counts only records from after the milestone's lanes started, and failed ones never", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const t0 = Date.now();
    await passGate(run, "M1", new Date(t0 - 60_000).toISOString());
    const deps = fakeDeps({ now: () => t0 });
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    const c = commitFiles(repo, ["src/a.ts"]);
    expect((await refusal(land(deps, landing(run.id, c)))).code).toBe("E_LAND_GATE");
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "reviewer-M1",
        role: "reviewer",
        status: "failed",
        endedAt: new Date(t0 + 1000).toISOString(),
      }),
    );
    expect((await refusal(land(deps, landing(run.id, c)))).message).toContain("reviewer record");
    await passGate(run, "M1", new Date(t0 + 2000).toISOString());
    expect((await land(deps, landing(run.id, c))).ledger).toStartWith("M1 |");
  });

  it("takes a headless verifier's dispatch record as the verdict only when its reply opens VERDICT: PASS", async () => {
    const { repo, run } = freshRun();
    const c = commitFiles(repo, ["src/a.ts"]);
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "reviewer-M1",
        role: "reviewer",
        endedAt: new Date().toISOString(),
      }),
    );
    const verifier = async (reply: string | null) => {
      const dispatchId = newDispatchId();
      const replyPath = `roles/verifier-M1/${dispatchId}/reply.md`;
      if (reply !== null) {
        mkdirSync(dirname(join(run.dir, replyPath)), { recursive: true });
        writeFileSync(join(run.dir, replyPath), reply);
      }
      await appendRecord(
        run,
        makeRecord({
          runId: run.id,
          dispatchId,
          name: "verifier-M1",
          role: "verifier",
          replyPath,
          endedAt: new Date().toISOString(),
        }),
      );
    };
    // the CLI exited cleanly, but the verdict is FAIL, or there is no reply to read: no verdict
    await verifier("VERDICT: FAIL\nA1 FAIL bun test: 1 fail\nSTATUS: complete — checked\n");
    await verifier(null);
    await verifier("All good, I think.\nVERDICT: PASS\n");
    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(e.message).toContain("a verifier verdict");
    expect(e.fix).not.toContain("bare VERDICT: PASS");
    // a verdict in markdown fails safe, and the fix says why (1.1 follow-ups)
    await verifier("**VERDICT: PASS**\nA1 PASS bun test\n");
    const md = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(md.message).toContain("is **VERDICT: PASS**");
    expect(md.fix).toStartWith(
      `the reply's first line must be the bare VERDICT: PASS, and verifier-M1's is "**VERDICT: PASS**", which counts as no verdict`,
    );
    await verifier("\nVERDICT: PASS\nA1 PASS bun test\nSTATUS: complete — all pass\n");
    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
    // the digest names the verdict the gate took, not "none" for want of a record_agent_run row
    expect(readFileSync(join(run.dir, "digests", "M1.md"), "utf8")).toContain(
      "Verifier: PASS (verifier-M1, headless)",
    );
  });

  it("gates on the latest native verifier attempt: a FAIL after a PASS refuses, a PASS after it lands", async () => {
    const { repo, run } = freshRun();
    const c = commitFiles(repo, ["src/a.ts"]);
    const t0 = Date.now();
    await passGate(run, "M1", new Date(t0).toISOString());
    const verdict = (at: number, status: "ok" | "failed") =>
      appendAgentRun(run, {
        at: new Date(at).toISOString(),
        name: "verifier-M1",
        role: "verifier",
        rung: "claude:claude-opus-5-5#low",
        agent: null,
        totalTokens: 0,
        costUsd: null,
        secs: null,
        status,
        lane: null,
      });
    verdict(t0 + 1000, "failed");
    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toContain("a verifier verdict");
    expect(e.message).toContain("the latest, verifier-M1, is failed");
    expect(e.message).not.toContain("reviewer record");
    verdict(t0 + 2000, "ok");
    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
    expect(readFileSync(join(run.dir, "digests", "M1.md"), "utf8")).toContain("Verifier: PASS (verifier-M1)");
  });

  it("gates on the latest headless verifier attempt, whatever its reply: FAIL after PASS refuses", async () => {
    const { repo, run } = freshRun();
    const c = commitFiles(repo, ["src/a.ts"]);
    const t0 = Date.now();
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "reviewer-M1",
        role: "reviewer",
        endedAt: new Date(t0).toISOString(),
      }),
    );
    const verifier = async (reply: string, at: number) => {
      const dispatchId = newDispatchId();
      const replyPath = `roles/verifier-M1/${dispatchId}/reply.md`;
      mkdirSync(dirname(join(run.dir, replyPath)), { recursive: true });
      writeFileSync(join(run.dir, replyPath), reply);
      await appendRecord(
        run,
        makeRecord({
          runId: run.id,
          dispatchId,
          name: "verifier-M1",
          role: "verifier",
          replyPath,
          endedAt: new Date(at).toISOString(),
        }),
      );
    };
    await verifier("VERDICT: PASS\nA1 PASS bun test\n", t0 + 1000);
    await verifier("VERDICT: FAIL\nA1 FAIL bun test: 1 fail\n", t0 + 2000);
    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toContain("the latest, verifier-M1 (headless), is VERDICT: FAIL");
    await verifier("VERDICT: PASS\nA1 PASS bun test\n", t0 + 3000);
    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
    expect(readFileSync(join(run.dir, "digests", "M1.md"), "utf8")).toContain(
      "Verifier: PASS (verifier-M1, headless)",
    );
  });

  it("treats VERDICT: BLOCKED: environment as a blocker to surface, in land and in the next step (plan 23)", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(fakeDeps(), { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    const c = commitFiles(repo, ["src/a.ts"]);
    const t0 = Date.now() + 1000;
    appendAgentRun(run, {
      at: new Date(t0 - 500).toISOString(),
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
    await passGate(run, "M1", new Date(t0).toISOString());
    const dispatchId = newDispatchId();
    const replyPath = `roles/verifier-M1/${dispatchId}/reply.md`;
    mkdirSync(dirname(join(run.dir, replyPath)), { recursive: true });
    writeFileSync(
      join(run.dir, replyPath),
      "VERDICT: BLOCKED: environment — curl http://172.17.0.2:8080 from a Go binary: no route to host, twice\nSTATUS: blocked — the VPN filter\n",
    );
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId,
        name: "verifier-M1",
        role: "verifier",
        replyPath,
        endedAt: new Date(t0 + 1000).toISOString(),
      }),
    );
    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toBe(
      "land M1: verifier-M1 is blocked by the environment: curl http://172.17.0.2:8080 from a Go binary: no route to host, twice",
    );
    expect(e.fix).toContain('park(run, "M1"');
    expect(protocolNext(run, [])).toBe(
      "M1: verifier-M1 is blocked by the environment (curl http://172.17.0.2:8080 from a Go binary: no route to host, twice): surface it to the owner (park M1), not a fix round",
    );
    // a native verifier says it through record_agent_run's verdict
    const claude = { host: "claude-code" as const, session: null, conflict: null };
    recordAgentRun(fakeDeps({ host: claude, now: () => t0 + 2000 }), {
      run: run.id,
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      totalTokens: 1,
      status: "failed",
      verdict: "VERDICT: BLOCKED: environment - docker compose: minio-buckets cannot resolve minio\nmore",
    });
    expect((await refusal(land(fakeDeps(), landing(run.id, c)))).message).toBe(
      "land M1: verifier-M1 is blocked by the environment: docker compose: minio-buckets cannot resolve minio",
    );
    // a plain FAIL stays a fix round
    recordAgentRun(fakeDeps({ host: claude, now: () => t0 + 3000 }), {
      run: run.id,
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      totalTokens: 1,
      status: "failed",
      verdict: "VERDICT: FAIL",
    });
    expect(protocolNext(run, [])).toStartWith("M1: verifier-M1 failed: the owning lanes fix it");
  });

  it("refuses a native reviewer recorded with reply_status partial, until a full pass (plan 23)", async () => {
    const { repo, run } = freshRun();
    const c = commitFiles(repo, ["src/a.ts"]);
    const claude = { host: "claude-code" as const, session: null, conflict: null };
    const t0 = Date.now();
    const review = (name: string, at: number, replyStatus?: "partial" | "complete") =>
      recordAgentRun(fakeDeps({ host: claude, now: () => at }), {
        run: run.id,
        name,
        role: "reviewer",
        rung: "claude:claude-opus-5-5#low",
        totalTokens: 1,
        ...(replyStatus ? { replyStatus } : {}),
      });
    review("reviewer-M1", t0, "partial");
    appendAgentRun(run, {
      at: new Date(t0 + 100).toISOString(),
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 0,
      costUsd: null,
      secs: null,
      status: "ok",
    });
    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
    expect(e.message).toBe(
      "land M1: reviewer-M1 replied STATUS: partial, which is not the milestone's review",
    );
    expect(e.fix).toContain("reviewer-M1-2");
    review("reviewer-M1-2", t0 + 200, "complete");
    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
  });

  it("takes a native reviewer (record_agent_run, role reviewer, reviewer-<M>, ok) since the milestone started", async () => {
    const { repo, run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const t0 = Date.now();
    const deps = fakeDeps({ now: () => t0 });
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    const c = commitFiles(repo, ["src/a.ts"]);
    const reviewer = (name: string, at: number, status: "ok" | "failed" = "ok", role = "reviewer") =>
      appendAgentRun(run, {
        at: new Date(at).toISOString(),
        name,
        role,
        rung: "claude:claude-opus-5-5#medium",
        agent: null,
        totalTokens: 5,
        costUsd: null,
        secs: null,
        status,
        lane: null,
      });
    appendAgentRun(run, {
      at: new Date(t0 + 500).toISOString(),
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 5,
      costUsd: null,
      secs: null,
      status: "ok",
      lane: null,
    });
    reviewer("reviewer-M1", t0 - 60_000);
    reviewer("reviewer-M1", t0 + 1000, "failed");
    reviewer("reviewer-M10", t0 + 1000);
    reviewer("reviewer-M1", t0 + 1000, "ok", "worker");
    expect(reviewerPassed(run, "M1")).toBe(false);
    expect((await refusal(land(deps, landing(run.id, c)))).message).toContain("a reviewer record");
    reviewer("reviewer-M1-fix", t0 + 2000);
    expect(reviewerPassed(run, "M1")).toBe(true);
    expect((await land(deps, landing(run.id, c))).ledger).toStartWith("M1 |");
    expect(readFileSync(join(run.dir, "digests", "M1.md"), "utf8")).toContain(
      "Reviewer: reviewer-M1-fix · a Claude subagent (findings in its reply)",
    );
  });

  it("judges the first milestone's skip from the HEAD the run started on, not its last commit only", async () => {
    const { repo } = freshRun();
    const { run: id } = await startRun(fakeDeps(), { repo, title: "t", aLines: ["A1"] });
    expect(findRun(id).meta.startHead).toMatch(/^[0-9a-f]{40}$/);
    commitFiles(repo, ["src/a.ts"]);
    const docs = commitFiles(repo, ["docs/a.md"]);
    const e = await refusal(land(fakeDeps(), landing(id, docs, { skip: "docs-only" })));
    expect(e.message).toBe('land M1: skip "docs-only" refused: files outside the docs changed: src/a.ts');
    // a run from before 1.5 (no startHead) keeps the commit's own parent
    const { run: old } = freshRun();
    commitFiles(old.meta.repo, ["src/a.ts"]);
    const only = commitFiles(old.meta.repo, ["docs/a.md"]);
    expect((await land(fakeDeps(), landing(old.id, only, { skip: "docs-only" }))).ledger).toStartWith("M1 |");
  });

  it("refuses a skip over an empty commit range: nothing to land", async () => {
    const { repo, run } = freshRun();
    const first = commitFiles(repo, ["docs/a.md"]);
    await land(fakeDeps(), landing(run.id, first, { skip: "docs-only" }));
    for (const skip of ["docs-only", "no-code"]) {
      const e = await refusal(land(fakeDeps(), landing(run.id, first, { milestone: "M2", skip })));
      expect(e.code).toBe("E_LAND_GATE");
      expect(e.message).toBe(
        `land M2: skip "${skip}" refused: the commit range changed nothing since M1 landed`,
      );
      expect(e.fix).toContain("commit the milestone first");
    }
  });

  it("matches the milestone as a word in the verifier's name", () => {
    expect(namesMilestone("verifier-M1", "M1")).toBe(true);
    expect(namesMilestone("M1-verifier", "M1")).toBe(true);
    expect(namesMilestone("verifier-M10", "M1")).toBe(false);
    expect(namesMilestone("verifierM1", "M1")).toBe(false);
  });

  it("ends the milestone in a name at the end, '-', '.', '_' or whitespace, for reviewer and verifier alike", () => {
    const refused = ["M1fix", "M1A", "M10"];
    const accepted = ["M1", "M1-fix", "M1.2", "M1_x"];
    expect(refused.map((s) => namesMilestone(`verifier-${s}`, "M1"))).toEqual([false, false, false]);
    expect(refused.map((s) => reviewsMilestone(`reviewer-${s}`, "M1"))).toEqual([false, false, false]);
    expect(accepted.map((s) => namesMilestone(`verifier-${s}`, "M1"))).toEqual([true, true, true, true]);
    expect(accepted.map((s) => reviewsMilestone(`reviewer-${s}`, "M1"))).toEqual([true, true, true, true]);
    expect(namesMilestone("M1 verifier", "M1")).toBe(true);
    expect(reviewsMilestone("reviewer-M1 again", "M1")).toBe(true);
  });

  it("takes reviewer-<M> followed by the end, '-', '.' or '_' as M's reviewer, never reviewer-M10 for M1", async () => {
    expect(
      ["reviewer-M1", "reviewer-M1-fix", "reviewer-M1.2", "reviewer-M1_b"].map((n) =>
        reviewsMilestone(n, "M1"),
      ),
    ).toEqual([true, true, true, true]);
    expect(["reviewer-M10", "reviewer-M1x", "reviewer-M2"].map((n) => reviewsMilestone(n, "M1"))).toEqual([
      false,
      false,
      false,
    ]);
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "reviewer-M10",
        role: "reviewer",
        lane: null,
        endedAt: new Date().toISOString(),
      }),
    );
    expect(reviewerPassed(run, "M1", null)).toBe(false);
  });

  it("counts only the repo's own docs/ folder as docs: a nested docs/ folder holds code", () => {
    expect(["docs/a.ts", "docs/guide/x.json", "app/docs/intro.md"].map(isDocPath)).toEqual([
      true,
      true,
      true,
    ]);
    expect(["app/docs/page.tsx", "src/docs/handler.ts", "website/docs/x.json"].map(isDocPath)).toEqual([
      false,
      false,
      false,
    ]);
    expect(["app/docs/page.tsx", "src/docs/handler.ts"].map(isSourcePath)).toEqual([true, true]);
  });

  it("counts prose .txt files as docs, but not dependency or build manifests", () => {
    expect(["notes.txt", "docs/a.json", "README.md", "LICENSE.txt"].map(isDocPath)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      [
        "requirements.txt",
        "requirements-dev.txt",
        "py/constraints.txt",
        "CMakeLists.txt",
        "src/x/CMakeLists.txt",
      ].map(isDocPath),
    ).toEqual([false, false, false, false, false]);
  });

  it("lands a docs-only milestone with skip, and refuses the skip when code changed", async () => {
    const { repo, run } = freshRun();
    const docs = commitFiles(repo, ["docs/guide.md", "README.md"]);
    expect((await land(fakeDeps(), landing(run.id, docs, { skip: "docs-only" }))).ledger).toStartWith("M1 |");
    const mixed = commitFiles(repo, ["docs/b.md", "src/a.ts", "package.json", "app/docs/page.tsx"]);
    const e = await refusal(land(fakeDeps(), landing(run.id, mixed, { milestone: "M2", skip: "docs-only" })));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toBe(
      'land M2: skip "docs-only" refused: files outside the docs changed: app/docs/page.tsx, package.json, src/a.ts',
    );
  });

  it("refuses a skip on a commit that is not HEAD: later source commits would bypass the reviewer", async () => {
    const { repo, run } = freshRun();
    const docs = commitFiles(repo, ["docs/guide.md"]);
    commitFiles(repo, ["src/a.ts"]);
    for (const skip of ["docs-only", "no-code"]) {
      const e = await refusal(land(fakeDeps(), landing(run.id, docs, { skip })));
      expect(e.code).toBe("E_LAND_GATE");
      expect(e.message).toStartWith(`land M1: skip "${skip}" refused: ${docs} is not HEAD (`);
      expect(e.fix).toContain("land M1 with HEAD");
    }
    expect(readFileSync(join(run.dir, "ledger.md"), "utf8")).not.toContain("M1 |");
  });

  it("lands a no-code milestone with skip, measuring from the last landed commit, and refuses source changes", async () => {
    const { repo, run } = freshRun();
    const first = commitFiles(repo, ["src/a.ts"]);
    await passGate(run, "M1");
    await land(fakeDeps(), landing(run.id, first));
    const config = commitFiles(repo, ["package.json", ".github/workflows/ci.yml"]);
    expect(
      (await land(fakeDeps(), landing(run.id, config, { milestone: "M2", skip: "no-code" }))).ledger,
    ).toStartWith("M2 |");
    const code = commitFiles(repo, ["src/b.ts"]);
    const e = await refusal(land(fakeDeps(), landing(run.id, code, { milestone: "M3", skip: "no-code" })));
    expect(e.message).toBe('land M3: skip "no-code" refused: source files changed: src/b.ts');
  });
});

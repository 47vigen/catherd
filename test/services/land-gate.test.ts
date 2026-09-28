import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { newDispatchId } from "../../src/domain/ids.ts";
import { land, route } from "../../src/services/lane-service.ts";
import { namesMilestone } from "../../src/services/milestones.ts";
import { appendAgentRun, appendRecord } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, makeRecord, passGate, writeLane } from "./helpers.ts";

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
  it("refuses a milestone with no reviewer record and no verifier verdict, naming both", async () => {
    const { repo, run } = freshRun();
    const e = await refusal(land(fakeDeps(), landing(run.id, commitFiles(repo, ["src/a.ts"]))));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toBe(
      "land M1: missing a reviewer record (a dispatch named reviewer-M1, status ok) and a verifier verdict (record_agent_run with role verifier and a name holding M1, status ok), since its lanes started",
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

  it("takes a headless verifier's dispatch record as the verdict", async () => {
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
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "verifier-M1",
        role: "verifier",
        endedAt: new Date().toISOString(),
      }),
    );
    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
  });

  it("matches the milestone as a word in the verifier's name", () => {
    expect(namesMilestone("verifier-M1", "M1")).toBe(true);
    expect(namesMilestone("M1-verifier", "M1")).toBe(true);
    expect(namesMilestone("verifier-M10", "M1")).toBe(false);
    expect(namesMilestone("verifierM1", "M1")).toBe(false);
  });

  it("lands a docs-only milestone with skip, and refuses the skip when code changed", async () => {
    const { repo, run } = freshRun();
    const docs = commitFiles(repo, ["docs/guide.md", "README.md"]);
    expect((await land(fakeDeps(), landing(run.id, docs, { skip: "docs-only" }))).ledger).toStartWith("M1 |");
    const mixed = commitFiles(repo, ["docs/b.md", "src/a.ts", "package.json"]);
    const e = await refusal(land(fakeDeps(), landing(run.id, mixed, { milestone: "M2", skip: "docs-only" })));
    expect(e.code).toBe("E_LAND_GATE");
    expect(e.message).toBe(
      'land M2: skip "docs-only" refused: files outside the docs changed: package.json, src/a.ts',
    );
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

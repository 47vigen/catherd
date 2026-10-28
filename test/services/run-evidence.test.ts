import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { evidenceLine, evidenceOf, runEvidence } from "../../src/services/run-evidence.ts";
import { appendAgentRun, appendRecord } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { createRun } from "../../src/services/run-store.ts";
import { freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

const LUNA = "codex:gpt-6-luna#high";
const SOL = "codex:gpt-6-sol#medium";

describe("run evidence (spec 1.2 §8, plan 50)", () => {
  it("counts dispatches and replies per rung, over every kind, across every repo's runs", async () => {
    const { run } = freshRun();
    await appendRecord(
      run,
      makeRecord({ dispatchId: "A", lane: "M1.L1", rung: LUNA, replyStatus: "blocked" }),
    );
    await appendRecord(
      run,
      makeRecord({ dispatchId: "B", lane: "M1.L2", rung: LUNA, replyStatus: "partial" }),
    );
    await appendRecord(run, makeRecord({ dispatchId: "C", lane: null, rung: SOL }));
    // a second repo on this machine counts too
    const other = createRun({ repo: tempRepo(), title: "o", aLines: ["A1"], version: "0.0.0-test" });
    await appendRecord(other, makeRecord({ dispatchId: "D", rung: LUNA }));
    const t = runEvidence(loadCatalog());
    expect(t["gpt-6-luna#high|*"]).toEqual({ lanes: 3, partial: 1, blocked: 1, refused: 0, fails: 0 });
    expect(t["gpt-6-luna#high|repo_code"]).toBeUndefined();
    expect(evidenceLine(evidenceOf(t, "gpt-6-luna#high", "repo_code"))).toBe("3 lanes, 1 partial, 1 blocked");
    expect(evidenceLine(evidenceOf(t, "gpt-6-sol#medium"))).toBe("1 lane");
    expect(evidenceLine(evidenceOf(t, "gpt-6-astra#max"))).toBeNull();
  });

  it("counts a verifier's FAILs on the rung that gave them, headless or native", async () => {
    const { run } = freshRun();
    const reply = "roles/verifier-M1/V1/reply.md";
    mkdirSync(dirname(join(run.dir, reply)), { recursive: true });
    writeFileSync(join(run.dir, reply), "VERDICT: FAIL\nA1 FAIL bun test\nSTATUS: complete — checked");
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "V1",
        name: "verifier-M1",
        role: "verifier",
        lane: null,
        rung: SOL,
        replyPath: reply,
      }),
    );
    appendAgentRun(run, {
      at: "2026-09-28T11:00:00.000Z",
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 10,
      costUsd: null,
      secs: 60,
      status: "failed",
    });
    const t = runEvidence(loadCatalog());
    expect(t["gpt-6-sol#medium|*"]).toMatchObject({ fails: 1, lanes: 1 });
    expect(t["claude-opus-5-5#low|*"]).toMatchObject({ fails: 1 });
    expect(evidenceLine(t["gpt-6-sol#medium|*"] ?? null)).toBe("1 lane, 1 verifier FAIL");
  });

  it("is empty with no runs", () => {
    freshRun();
    expect(runEvidence(loadCatalog())).toEqual({});
  });
});

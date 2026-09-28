import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Kind } from "../../src/domain/lane.ts";
import type { RouteRow } from "../../src/domain/route.ts";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { evidenceLine, evidenceOf, runEvidence } from "../../src/services/run-evidence.ts";
import { appendAgentRun, appendRecord, appendRoute, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { createRun } from "../../src/services/run-store.ts";
import { freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

const LUNA = "codex:gpt-6-luna#high";
const SOL = "codex:gpt-6-sol#medium";

const row = (o: Partial<RouteRow> & Pick<RouteRow, "lane" | "rung">): RouteRow => ({
  at: "2026-09-28T10:00:00.000Z",
  role: "worker",
  ladder: [LUNA, SOL],
  source: "route",
  decidedBy: "lane",
  from: null,
  reason: null,
  kind: "repo_code",
  difficulty: "build",
  ...o,
});

function lane(run: Run, id: string, kind: Kind, climbTo?: string): void {
  appendRoute(run, row({ lane: id, rung: LUNA, kind }));
  if (climbTo)
    appendRoute(
      run,
      row({
        lane: id,
        rung: climbTo,
        kind,
        source: "climb",
        from: LUNA,
        reason: "blocked",
        at: "2026-09-28T10:30:00.000Z",
      }),
    );
}

describe("run evidence (spec 1.2 §8)", () => {
  it("counts lanes, climbs and replies per rung and kind, and over every kind, across every repo's runs", async () => {
    const { run } = freshRun();
    lane(run, "M1.L1", "repo_code", SOL);
    lane(run, "M1.L2", "repo_code");
    lane(run, "M1.L3", "terminal");
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "A",
        lane: "M1.L1",
        rung: LUNA,
        replyStatus: "blocked",
        startedAt: "2026-09-28T10:01:00.000Z",
      }),
    );
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "B",
        lane: "M1.L2",
        rung: LUNA,
        replyStatus: "partial",
        startedAt: "2026-09-28T10:01:00.000Z",
      }),
    );
    // a second repo on this machine counts too
    const other = createRun({ repo: tempRepo(), title: "o", aLines: ["A1"], version: "0.0.0-test" });
    lane(other, "M1.L1", "repo_code");
    const t = runEvidence(loadCatalog({ timings: false }));
    expect(t["gpt-6-luna#high|repo_code"]).toEqual({
      lanes: 3,
      climbed: 1,
      partial: 1,
      blocked: 1,
      refused: 0,
      fails: 0,
    });
    expect(t["gpt-6-luna#high|terminal"]).toMatchObject({ lanes: 1, climbed: 0 });
    expect(t["gpt-6-luna#high|*"]).toMatchObject({ lanes: 4, climbed: 1, partial: 1, blocked: 1 });
    expect(t["gpt-6-sol#medium|repo_code"]).toMatchObject({ lanes: 1, climbed: 0 });
    expect(evidenceLine(evidenceOf(t, "gpt-6-luna#high", "repo_code"))).toBe(
      "3 lanes, 1 climbed, 1 partial, 1 blocked",
    );
    expect(evidenceLine(evidenceOf(t, "gpt-6-luna#high", "ui"))).toBe(
      "4 lanes, 1 climbed, 1 partial, 1 blocked",
    );
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
    const t = runEvidence(loadCatalog({ timings: false }));
    expect(t["gpt-6-sol#medium|*"]).toMatchObject({ fails: 1, lanes: 0 });
    expect(t["claude-opus-5-5#low|*"]).toMatchObject({ fails: 1 });
    expect(evidenceLine(t["gpt-6-sol#medium|*"] ?? null)).toBe("0 lanes, 1 verifier FAIL");
  });

  it("is empty with no runs", () => {
    freshRun();
    expect(runEvidence(loadCatalog({ timings: false }))).toEqual({});
  });
});

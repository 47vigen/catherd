import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunRecord } from "../../src/domain/record.ts";
import { roleScorecard } from "../../src/services/run-scorecard.ts";
import { endDispatch, makeLog, startDispatch } from "../domain/run-fixtures.ts";
import { freshRun, makeRecord } from "./helpers.ts";

describe("the run scorecard (plan 44 task 20)", () => {
  it("the scorecard counts what the run did", () => {
    const { run } = freshRun();
    const log = makeLog();
    const dispatch = (
      name: string,
      role: string,
      lane: string | null,
      o: { brief?: number; reply?: string; input?: number; cached?: number; reason?: "too_hard" },
    ): RunRecord => {
      const id = startDispatch(log, { name, role, unit: lane ?? "M1", lane });
      endDispatch(log, id, { name, unit: lane ?? "M1", reason: o.reason ?? null });
      const record = makeRecord({
        dispatchId: id,
        name,
        role,
        lane,
        secs: 30,
        tokens: { input: o.input ?? 0, cached: o.cached ?? 0, output: 1 },
        replyPath: `roles/${name}/${id}/reply.md`,
      });
      const folder = dirname(join(run.dir, record.replyPath));
      mkdirSync(folder, { recursive: true });
      if (o.brief !== undefined) writeFileSync(join(folder, "brief.md"), "x".repeat(o.brief));
      if (o.reply !== undefined) writeFileSync(join(folder, "reply.md"), o.reply);
      return record;
    };
    const records = [
      dispatch("worker-a", "worker", "M1.L1", {
        brief: 10 * 1024,
        input: 100,
        cached: 50,
        reason: "too_hard",
      }),
      dispatch("worker-b", "worker", "M1.L1", { brief: 30 * 1024, input: 300, cached: 150 }),
      dispatch("verifier-M1", "verifier", null, {
        reply:
          "RAN: bun test — exit 0 — a.log\nRAN: bun run lint — exit 0 — b.log\nRAN: bun e2e — NOT RUN\nPASS\n",
      }),
    ];
    const card = roleScorecard(run, log.events, records);
    expect(card.map((s) => s.role)).toEqual(["verifier", "worker"]);
    expect(card.find((s) => s.role === "worker")).toMatchObject({
      dispatches: 2,
      briefBytes: { median: 20480, max: 30720 },
      inputTokens: 400,
      cacheHit: 0.5,
      wallSecs: 60,
      roundsPerLane: 2,
      stops: { too_hard: 1 },
      verifierRan: null,
    });
    expect(card.find((s) => s.role === "verifier")).toMatchObject({
      dispatches: 1,
      briefBytes: { median: 0, max: 0 },
      cacheHit: 0,
      roundsPerLane: null,
      verifierRan: 2,
    });
  });
});

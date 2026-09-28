import { afterEach, describe, expect, it } from "bun:test";
import { gateCheck } from "../../src/services/gate-service.ts";
import { PROTOCOL_CHECKLIST } from "../../src/services/protocol.ts";
import { park } from "../../src/services/questions.ts";
import { reentry } from "../../src/services/reentry.ts";
import { snapshotEnv } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

describe("re-entry (spec 1.1 §8, §10)", () => {
  it("gives the open questions, the protocol step with the parked milestones skipped, and the verifier's step", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M2.L1", ["src/b.ts"]);
    await park(deps, { run: run.id, milestone: "M1", question: "Which DB?" });
    await gateCheck(deps, { run: run.id, item: "lint", command: "bun run lint", paths: ["src/"] });
    const r = reentry(run);
    expect(r.questions.map((q) => [q.milestone, q.question])).toEqual([["M1", "Which DB?"]]);
    expect(r.protocol).toEqual({ next: "route and preflight M2's lanes", checklist: PROTOCOL_CHECKLIST });
    expect(r.verifier).toMatchObject({ item: "lint", carried: false });
  });

  it("peek returns them per run, questions first", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await park(deps, { run: run.id, milestone: "M1", question: "Which DB?" });
    const c = await mcpClient(deps);
    const p = (await call(c, "peek", { run: run.id })).data.runs[0];
    expect(Object.keys(p)[0]).toBe("questions");
    expect(p.questions[0].milestone).toBe("M1");
    expect(p.protocol.checklist).toHaveLength(6);
    expect(p.verifier).toBeNull();
  });
});

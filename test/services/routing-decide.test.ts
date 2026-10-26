import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { decisionState } from "../../src/domain/decision.ts";
import { readJsonl } from "../../src/infra/store.ts";
import { resetFreshen } from "../../src/services/catalog-service.ts";
import { decisionQuestions } from "../../src/services/decision-service.ts";
import type { DecideRequest, ProfileView } from "../../src/services/ports.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { LADDER, testView } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  withHome();
  resetFreshen();
  delete process.env.CATHERD_DECISION_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // no backend CLI answers a listing here: discovery stays empty
  process.env.PATH = "/nonexistent";
});

const noWait = { sleep: async () => {}, random: () => 0.5 };
// Luna xhigh on Codex and on OpenCode Go is one model: equal intelligence on two quotas
const CODEX_LUNA = "codex:gpt-6-luna#xhigh";
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#xhigh";

const view = (rungs: string[]): ProfileView =>
  testView({ roles: { ...testView().roles, worker: { enabled: true, access: "workspace-write", rungs } } });

const dirIn = () => mkdtempSync(join(process.env.CATHERD_HOME as string, "run-"));

function req(over: Partial<DecideRequest> & { rungs?: string[] } = {}): DecideRequest {
  const { rungs = LADDER, ...rest } = over;
  return {
    runDir: dirIn(),
    repo: "/nowhere",
    profile: view(rungs),
    role: "worker",
    name: "M1.L1",
    unit: "M1.L1",
    floor: null,
    strict: false,
    exclude: [],
    held: [],
    usage: {},
    state: decisionState({
      role: "worker",
      unit: "M1.L1",
      round: 0,
      isFix: false,
      floorRung: null,
      rungs: [],
      previous: [],
      spentFraction: 0,
      slack: null,
      brief: "Add GET /jobs like src/users.ts.",
    }),
    ...rest,
  };
}

/** The score answer over `probs`, every noul question answered 0.05 unless overridden. */
const reply = (probs: Record<string, number>, nouls: Record<string, number> = {}) => ({
  model: "test-decider",
  answers: {
    difficulty: { type: "score", score: 1, probabilities: probs, confidence: 0.9 },
    ...Object.fromEntries(
      Object.keys(decisionQuestions().sets.difficulty.nouls).map((id) => [
        id,
        { type: "noul", noul: nouls[id] ?? 0.05 },
      ]),
    ),
  },
  usage: { input_tokens: 10, output_tokens: 2 },
});

const svc = (f: ReturnType<typeof fakeFetch>) => routingService({ key: "k", fetchImpl: f.impl, ...noWait });
const criteria = (f: ReturnType<typeof fakeFetch>) =>
  (f.sent[0] as { body: { questions: { difficulty: { criteria: string[] } } } }).body.questions.difficulty
    .criteria;

describe("decide", () => {
  it("N is the role's levels above the floor", async () => {
    const f = fakeFetch({ status: 200, body: reply({ "0": 0.9 }) });
    await svc(f).decide(req({ floor: LADDER[1] as string }));
    expect(criteria(f)).toHaveLength(3);
    const g = fakeFetch({ status: 200, body: reply({ "0": 0.9 }) });
    await svc(g).decide(req({ floor: LADDER[1] as string, strict: true }));
    expect(criteria(g)).toHaveLength(2);
  });

  it("the picked level's rung runs, ties go to headroom", async () => {
    const rungs = [LADDER[0] as string, CODEX_LUNA, GO_LUNA, LADDER[2] as string];
    const probs = { "1": 0.9, "0": 0.05, "2": 0.05 };
    const f = fakeFetch({ status: 200, body: reply(probs) });
    const r = await svc(f).decide(req({ rungs, usage: { codex: 3, "opencode-go": 0 } }));
    expect(r).toMatchObject({ ok: true, rung: GO_LUNA, level: 1, levels: 3, source: "model" });
    expect(r.ok && r.levelRungs[1]).toEqual([CODEX_LUNA, GO_LUNA]);
    const g = fakeFetch({ status: 200, body: reply(probs) });
    const s = await svc(g).decide(req({ rungs, usage: { codex: 0, "opencode-go": 3 } }));
    expect(s).toMatchObject({ ok: true, rung: CODEX_LUNA });
  });

  it("one level asks nothing", async () => {
    const f = fakeFetch({ status: 200, body: reply({ "0": 1 }) });
    const dir = dirIn();
    const r = await svc(f).decide(req({ runDir: dir, floor: LADDER[3] as string }));
    expect(r).toMatchObject({ ok: true, rung: LADDER[3], level: 0, levels: 1, source: "floor", p: null });
    expect(f.sent).toHaveLength(0);
    // the decide effect writes the decision's row, so the port writes none (plan 44 D28)
    expect(readJsonl(join(dir, "decisions.jsonl")).rows).toEqual([]);
  });

  it("held and refused rungs leave the list", async () => {
    const rungs = [LADDER[0] as string, GO_LUNA, LADDER[1] as string, LADDER[2] as string];
    const f = fakeFetch({ status: 200, body: reply({ "0": 0.9 }) });
    const r = await svc(f).decide(req({ rungs, held: ["codex"], exclude: [LADDER[2] as string] }));
    // the codex quota is held and the sol#high rung refused: only the opencode-go rung is left
    expect(r).toMatchObject({ ok: true, rung: GO_LUNA, levels: 1, levelRungs: [[GO_LUNA]] });
    const none = await svc(f).decide(req({ held: ["codex"] }));
    expect(none).toMatchObject({ ok: false, exhausted: false, rungs: [] });
  });

  it("an unparsable answer is a failure, not a fallback", async () => {
    const f = fakeFetch({ status: 200, body: {} });
    const r = await svc(f).decide(req());
    expect(r).toMatchObject({ ok: false, exhausted: false, error: expect.any(String), rungs: LADDER });
  });

  it("the noul floor lifts a mechanical read", async () => {
    // five levels: sixIndex(2, 5) = round(2.5) = 3, the first level of six-index >= 3
    const rungs = [
      LADDER[0] as string,
      CODEX_LUNA,
      LADDER[1] as string,
      LADDER[2] as string,
      LADDER[3] as string,
    ];
    const probs = { "0": 0.95 };
    const plain = fakeFetch({ status: 200, body: reply(probs) });
    expect(await svc(plain).decide(req({ rungs }))).toMatchObject({ ok: true, level: 0 });
    const f = fakeFetch({ status: 200, body: reply(probs, { shared_state: 0.95 }) });
    const r = await svc(f).decide(req({ rungs }));
    expect(r).toMatchObject({ ok: true, level: 2, rung: LADDER[1] });
    expect(r.ok && r.why).toContain("shared_state");
  });

  it("a strict floor with nothing above it is exhausted", async () => {
    const f = fakeFetch({ status: 200, body: reply({ "0": 1 }) });
    expect(await svc(f).decide(req({ floor: LADDER[3] as string, strict: true }))).toEqual({
      ok: false,
      exhausted: true,
      floor: LADDER[3] as string,
    });
  });

  it("a profile with no decision model fails with the fix", async () => {
    const f = fakeFetch({ status: 200, body: reply({ "0": 1 }) });
    const profile = { ...view(LADDER), decision: { url: null, model: null, minConfidence: 0.8 } };
    const r = await svc(f).decide(req({ profile }));
    expect(r).toMatchObject({ ok: false, exhausted: false, error: expect.stringContaining("decision.url") });
    expect(f.sent).toHaveLength(0);
  });
});

describe("verdict and probe", () => {
  const verdictReply = (p: number) => ({
    model: "test-decider",
    answers: {
      finding: {
        type: "choice",
        choice: "design",
        probabilities: { design: p, code: 1 - p, unclear: 0 },
        confidence: 0.9,
      },
    },
  });

  it("a sure answer is its value, an unsure one the rule's fallback, an error no value", async () => {
    const sure = fakeFetch({ status: 200, body: verdictReply(0.95) });
    expect(await svc(sure).verdict(dirIn(), view(LADDER), "finding", { finding: "x" })).toEqual({
      ok: true,
      value: "design",
      p: 0.95,
    });
    const unsure = fakeFetch({ status: 200, body: verdictReply(0.5) });
    expect(await svc(unsure).verdict(dirIn(), view(LADDER), "finding", { finding: "x" })).toMatchObject({
      ok: true,
      value: decisionQuestions().sets.finding.rule.fallback,
      p: 0.5,
    });
    const bad = fakeFetch({ status: 200, body: {} });
    expect(await svc(bad).verdict(dirIn(), view(LADDER), "finding", { finding: "x" })).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
  });

  it("probe asks the profile's model once", async () => {
    const f = fakeFetch({ status: 200, body: reply({ "1": 0.9 }) });
    expect(await svc(f).probe(view(LADDER))).toMatchObject({ ok: true });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.url).toBe("https://decision.test/v1/systemone");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../../src/domain/decision.ts";
import {
  askDecision,
  DECISION_KEY_ENV,
  decisionKey,
  decisionQuestions,
  probeDecision,
  saveDecisionKey,
} from "../../src/services/decision-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  withHome();
  delete process.env[DECISION_KEY_ENV];
  delete process.env.TYPESAFE_API_KEY;
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const runDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "catherd-decision-"));
  dirs.push(d);
  return d;
};
const noWait = { sleep: async () => {}, random: () => 0.5 };
const cfg = { url: "https://gateway.test/v1", model: "test-decider", minConfidence: 0.8 };
const STATE = { role: "worker", brief: "Rename total to sum." };
const QUESTIONS = {
  difficulty: { type: "score" as const, instructions: "Which level?", criteria: ["a", "b", "c"] },
};
const reply = (model = "test-decider") => ({
  model,
  answers: {
    difficulty: { type: "score", score: 1, probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 }, confidence: 0.9 },
  },
  usage: { input_tokens: 10, output_tokens: 2 },
});

// every question the catalog's difficulty set asks, answered
const fullReply = () => {
  const r = reply();
  for (const id of Object.keys(decisionQuestions().sets.difficulty.nouls))
    (r.answers as Record<string, unknown>)[id] = { type: "noul", noul: 0.1 };
  return r;
};

describe("askDecision", () => {
  it("asks the profile's model at its url, and logs the state's hash, not the state", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: reply(), headers: { "x-request-id": "req_1" } });
    const o = { key: "k", fetchImpl: f.impl, ...noWait };
    const a = await askDecision(dir, cfg, "difficulty", STATE, QUESTIONS, o);
    expect(f.sent[0]?.url).toBe("https://gateway.test/v1/systemone");
    expect(f.sent[0]?.body).toMatchObject({ model: "test-decider", state: STATE, questions: QUESTIONS });
    expect(f.sent[0]?.headers.get("authorization")).toBe("Bearer k");
    expect(a.why).toBeNull();
    expect(a.answers?.difficulty?.type).toBe("score");
    expect(a.meta).toMatchObject({ model: "test-decider", requestId: "req_1", attempts: 1, cached: false });
    const text = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    const rows = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0]).toEqual({ schema: 1, kind: "decisions" });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ call: "difficulty", stateHash: sha256(canonicalJson(STATE)) });
    expect(text).not.toContain("Rename total");
  });

  it("answers the same request from the log, and asks again for a changed state", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: reply() });
    const o = { key: "k", fetchImpl: f.impl, ...noWait };
    const first = await askDecision(dir, cfg, "difficulty", STATE, QUESTIONS, o);
    const again = await askDecision(dir, cfg, "difficulty", { ...STATE }, QUESTIONS, o);
    expect(again.meta.cached).toBe(true);
    expect(again.answers).toEqual(first.answers);
    expect(f.sent).toHaveLength(1);
    await askDecision(dir, cfg, "difficulty", { ...STATE, brief: "else" }, QUESTIONS, o);
    expect(f.sent).toHaveLength(2);
  });

  it("sends no authorization without a key, and keeps no log without a run folder", async () => {
    const f = fakeFetch({ status: 200, body: reply() });
    const o = { key: null, fetchImpl: f.impl, ...noWait };
    const a = await askDecision(null, cfg, "difficulty", STATE, QUESTIONS, o);
    expect(f.sent[0]?.headers.has("authorization")).toBe(false);
    expect(a.answers).not.toBeNull();
  });

  it("says why on a failed call or an unparsable answer", async () => {
    const f = fakeFetch({ status: 401, body: {} });
    const bad = await askDecision(runDir(), cfg, "difficulty", STATE, QUESTIONS, {
      key: "k",
      fetchImpl: f.impl,
      ...noWait,
    });
    expect(bad.answers).toBeNull();
    expect(bad.why).toContain("401");
    const g = fakeFetch({ status: 200, body: {} });
    const odd = await askDecision(runDir(), cfg, "difficulty", STATE, QUESTIONS, {
      key: "k",
      fetchImpl: g.impl,
      ...noWait,
    });
    expect(odd).toMatchObject({ answers: null, why: "unexpected response" });
  });
});

describe("probeDecision", () => {
  it("needs a parsable answer", async () => {
    const ok = fakeFetch({ status: 200, body: fullReply() });
    expect(await probeDecision(cfg, { key: "k", fetchImpl: ok.impl, ...noWait })).toMatchObject({ ok: true });
    const sent = ok.sent[0]?.body as {
      state: { role: string; rungs: unknown[]; brief: string };
      questions: Record<string, { criteria: unknown[] }>;
    };
    expect(sent.state.role).toBe("worker");
    expect(sent.state.rungs).toHaveLength(3);
    expect(sent.state.brief.length).toBeLessThanOrEqual(200);
    expect(sent.questions.difficulty?.criteria).toHaveLength(3);
    const empty = fakeFetch({ status: 200, body: {} });
    expect(await probeDecision(cfg, { key: "k", fetchImpl: empty.impl, ...noWait })).toMatchObject({
      ok: false,
    });
    const down = fakeFetch(new Error("ECONNREFUSED"));
    const r = await probeDecision(cfg, { key: "k", fetchImpl: down.impl, retries: 0, ...noWait });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).not.toBe("");
  });
});

describe("the decision key", () => {
  it("comes from the env, then credentials", () => {
    expect(decisionKey()).toBeNull();
    saveDecisionKey(" b ");
    expect(decisionKey()).toBe("b");
    process.env[DECISION_KEY_ENV] = "a";
    expect(decisionKey()).toBe("a");
  });

  it("does not read TYPESAFE_API_KEY", () => {
    process.env.TYPESAFE_API_KEY = "t";
    expect(decisionKey()).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRun, readJsonl } from "../src/core/runstore.ts";
import { defaultProfile, patchProfile } from "../src/profile/profile.ts";
import { loadCatalog } from "../src/routing/catalog.ts";
import type { JevLogRow } from "../src/routing/jev.ts";
import { askFinding, askSameDefect, nextRung, route } from "../src/routing/route.ts";
import { fakeFetch } from "./fake-fetch.ts";
import { withHome } from "./helpers.ts";

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "jev", name), "utf8"));
const lane = "Lane M1.L2: add GET /jobs following GET /workers. Fast check: bun test test/jobs.test.ts";
const TRACK_A = ["gpt-6-luna#high", "gpt-6-sol#medium", "gpt-6-sol#high", "gpt-6-sol#xhigh"];
const TRACK_B = ["gpt-6-sol#medium", "gpt-6-sol#high", "gpt-6-sol#xhigh"];

let runDir: string;
const rows = () => readJsonl<JevLogRow>(join(runDir, "jev.jsonl"));
const worker = (fetchImpl: typeof fetch) => ({
  runDir,
  profile: defaultProfile(),
  catalog: loadCatalog(),
  role: "worker" as const,
  laneText: lane,
  fetchImpl,
  retryDelayMs: 1,
});

const saved = { ...process.env };
beforeEach(() => {
  withHome();
  process.env.TYPESAFE_API_KEY = "ts_test_key";
  runDir = createRun("/r/app", "t", []).dir;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("route", () => {
  test("puts a confident build lane on Track A and logs the decision", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect(await route(worker(f.impl))).toEqual({
      kind: "repo_code",
      difficulty: "build",
      confidence: { kind: 1, difficulty: 0.95 },
      source: "jev",
      rung: "gpt-6-luna#high",
      ladder: TRACK_A,
    });
    expect(f.sent[0]?.body).toMatchObject({ model: "jev-1.13.0", state: { lane } });
    expect(Object.keys((f.sent[0] as { body: { questions: object } }).body.questions)).toEqual([
      "kind",
      "difficulty",
    ]);
    expect(rows()).toMatchObject([
      { questions: ["kind", "difficulty"], used: "worker gpt-6-luna#high", source: "jev" },
    ]);
  });

  test("falls back to the default rung below 0.75, and keeps what Jev said", async () => {
    const d = await route(worker(fakeFetch({ status: 200, body: fx("route-unsure.json") }).impl));
    expect(d).toEqual({
      kind: "repo_code",
      difficulty: "hard",
      confidence: { kind: 0.73, difficulty: 0.78 },
      source: "default",
      rung: "gpt-6-sol#medium",
      ladder: TRACK_B,
    });
    expect(rows()[0]).toMatchObject({ used: "worker gpt-6-sol#medium", source: "default" });
    expect(rows()[0]?.why).toContain("0.73");
  });

  test("falls back when Jev is down, and says so in the log", async () => {
    const f = fakeFetch({ status: 503, body: {} });
    const d = await route(worker(f.impl));
    expect(d).toMatchObject({ source: "default", rung: "gpt-6-sol#medium", kind: null, difficulty: null });
    expect(f.sent).toHaveLength(4);
    expect(rows()[0]).toMatchObject({ answers: null, source: "default", why: "http 503" });
  });

  test("falls back on a revoked key without retrying, and never logs the key", async () => {
    const f = fakeFetch({ status: 401, body: fx("auth-error.json") });
    expect((await route(worker(f.impl))).source).toBe("default");
    expect(f.sent).toHaveLength(1);
    expect(readFileSync(join(runDir, "jev.jsonl"), "utf8")).not.toContain("ts_test_key");
  });

  test("falls back when Jev picks a kind that is not an option", async () => {
    const body = {
      answers: {
        kind: { choice: "devops", confidence: 0.99, probabilities: {} },
        difficulty: { choice: "build", confidence: 0.99, probabilities: {} },
      },
    };
    const d = await route(worker(fakeFetch({ status: 200, body }).impl));
    expect(d).toMatchObject({ source: "default", rung: "gpt-6-sol#medium", kind: null });
    expect(rows()[0]?.why).toBe("no valid answer to kind");
  });

  test("does not call Jev without a key", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect((await route(worker(f.impl))).source).toBe("default");
    expect(f.sent).toHaveLength(0);
    expect(rows()[0]?.why).toBe("no key");
  });

  test("does not route a role with a single entry", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect(await route({ ...worker(f.impl), role: "architect" })).toEqual({
      kind: null,
      difficulty: null,
      confidence: { kind: null, difficulty: null },
      source: "default",
      rung: "claude-opus-5-5#high",
      ladder: ["claude-opus-5-5#high"],
    });
    expect(f.sent).toHaveLength(0);
    expect(rows()).toEqual([]);
  });
});

describe("finding and same-defect", () => {
  test("sends a design finding to the architect when Jev is sure", async () => {
    const f = fakeFetch({ status: 200, body: fx("finding-design.json") });
    expect(
      await askFinding(runDir, lane, "BLOCKER: the signature cannot carry the key", { fetchImpl: f.impl }),
    ).toEqual({
      value: "design",
      confidence: 1,
      source: "jev",
    });
    expect(f.sent[0]?.body).toMatchObject({
      state: { lane, finding: "BLOCKER: the signature cannot carry the key" },
    });
  });

  test("defaults an unsure finding to code", async () => {
    const f = fakeFetch({ status: 200, body: fx("finding-unsure.json") });
    expect(await askFinding(runDir, lane, "MAJOR: retries look off here.", { fetchImpl: f.impl })).toEqual({
      value: "code",
      confidence: 0.5,
      source: "default",
    });
    expect(rows()[0]).toMatchObject({ questions: ["finding"], used: "code", source: "default" });
  });

  test("answers same-defect from Jev, and defaults to no when Jev is unavailable", async () => {
    const yes = fakeFetch({ status: 200, body: fx("same-defect-yes.json") });
    expect(await askSameDefect(runDir, "no ORDER BY", "pages repeat rows", { fetchImpl: yes.impl })).toEqual({
      value: "yes",
      confidence: 1,
      source: "jev",
    });
    expect(yes.sent[0]?.body).toMatchObject({ state: { before: "no ORDER BY", after: "pages repeat rows" } });
    const no = fakeFetch({ status: 200, body: fx("same-defect-no.json") });
    expect((await askSameDefect(runDir, "a", "b", { fetchImpl: no.impl })).value).toBe("no");
    const down = fakeFetch({ status: 401, body: fx("auth-error.json") });
    expect(await askSameDefect(runDir, "a", "b", { fetchImpl: down.impl })).toEqual({
      value: "no",
      confidence: null,
      source: "default",
    });
    expect(rows()).toHaveLength(3);
  });
});

describe("nextRung", () => {
  test("climbs one rung, and returns null on the top rung or off the ladder", () => {
    expect(nextRung(TRACK_A, "gpt-6-luna#high")).toBe("gpt-6-sol#medium");
    expect(nextRung(TRACK_A, "gpt-6-sol#high")).toBe("gpt-6-sol#xhigh");
    expect(nextRung(TRACK_A, "gpt-6-sol#xhigh")).toBeNull();
    expect(nextRung(TRACK_B, "gpt-6-luna#high")).toBeNull();
  });
});

/** spec §11b: at 80% of budget, route starts on the cheapest bar-clearing rung, whatever the objective. */
describe("route with a budget", () => {
  test("forces the cheapest bar-clearing start at 0.8 spent, even under objective speed", async () => {
    const p = patchProfile(defaultProfile(), { objective: "speed" });
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    const d = await route({ ...worker(f.impl), profile: p, budget: { spentFraction: 0.8 } });
    // Under plain speed (no budget) this lane would start on sol#medium (fastest, cost_rank 2);
    // the cheapest bar-clearing candidate for repo_code/build is luna#high (cost_rank 1).
    expect(d.rung).toBe("gpt-6-luna#high");
    expect(d.source).toBe("jev");
  });

  test("does not touch the pick below 0.8 spent", async () => {
    const p = patchProfile(defaultProfile(), { objective: "speed" });
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    const d = await route({ ...worker(f.impl), profile: p, budget: { spentFraction: 0.79 } });
    expect(d.rung).toBe("gpt-6-sol#medium");
  });

  test("still forces the cheapest start when Jev is down and the lane falls back", async () => {
    const f = fakeFetch({ status: 503, body: {} });
    const d = await route({ ...worker(f.impl), budget: { spentFraction: 1 } });
    // The default profile is already objective cost, whose cheapest candidate is the start anyway.
    expect(d.rung).toBe("gpt-6-sol#medium");
    expect(d.source).toBe("default");
  });
});

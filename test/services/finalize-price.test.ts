import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pairOf } from "../../src/domain/catalog.ts";
import { tokensUsd } from "../../src/domain/cost.ts";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { withOpencodeScenario } from "../sim/sim-scenarios.ts";
import { fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
const events = readFileSync(
  join(import.meta.dir, "../fixtures/adapters/codex/ok-with-reconnect.jsonl"),
  "utf8",
);
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

it("a Codex run with a catalog price gets a cost", async () => {
  const { run } = freshRun();
  const d = await fakeDispatch(run, {}, { exit, events });
  const price = pairOf(loadCatalog({ runDir: run.dir }), d.admit.rung)?.price;
  expect(price).toBeDefined();
  if (!price) throw new Error("the fixture rung needs a catalog price");
  const record = await finalizeDispatch(run, d);
  expect(record.costUsd).toBeCloseTo(tokensUsd(price, record.tokens), 9);
  expect(readRecords(run).records[0]?.costUsd).toBe(record.costUsd);
});

it("a rung with no price stays null", async () => {
  const { run } = freshRun();
  const d = await fakeDispatch(run, { rung: "codex:unpriced-test-model#medium" }, { exit, events });
  expect((await finalizeDispatch(run, d)).costUsd).toBeNull();
});

it("keeps the backend's reported cost", async () => {
  const { run } = freshRun();
  const d = await fakeDispatch(
    run,
    { backend: "claude-code", rung: "claude-code:claude-sonnet-5#high" },
    {
      exit,
      events: JSON.stringify({
        type: "result",
        result: "ok",
        total_cost_usd: 0,
        usage: { input_tokens: 100 },
      }),
    },
  );
  expect((await finalizeDispatch(run, d)).costUsd).toBe(0);
});

it("subtracts all earlier cache writes when finalizing resumed OpenCode sessions", async () => {
  const { run } = freshRun();
  process.env.PATH = simPath();
  const thread = "ses_cache_write_resume";
  const cumulativeWrites = [0, 10, 30, 60];
  const records = [];
  for (const [i, write] of cumulativeWrites.entries()) {
    const turns = i + 1;
    Object.assign(
      process.env,
      withOpencodeScenario({
        session: {
          cost: turns,
          outcome: "succeeded",
          tokens: { input: turns * 10, output: turns, cache: { read: turns * 5, write } },
        },
      }).env,
    );
    const d = await fakeDispatch(
      run,
      {
        backend: "opencode",
        rung: "opencode:anthropic/claude-sonnet-5#high",
        thread,
      },
      {
        exit,
        events: JSON.stringify({ type: "step_finish", sessionID: thread, part: { cost: 0 } }),
      },
    );
    records.push(await finalizeDispatch(run, d));
  }
  expect(records.map((r) => ({ ...r.tokens, cacheWrite: r.tokens.cacheWrite ?? 0 }))).toEqual([
    { input: 15, cached: 5, cacheWrite: 0, output: 1 },
    { input: 25, cached: 5, cacheWrite: 10, output: 1 },
    { input: 35, cached: 5, cacheWrite: 20, output: 1 },
    { input: 45, cached: 5, cacheWrite: 30, output: 1 },
  ]);
  expect(records.map((r) => r.tokens.input - r.tokens.cached - (r.tokens.cacheWrite ?? 0))).toEqual([
    10, 10, 10, 10,
  ]);
});

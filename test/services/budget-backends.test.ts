import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { readyAdapter, resetReadiness } from "../../src/services/backends.ts";
import { budgetOf, liveTokens, spendOf } from "../../src/services/budget.ts";
import { appendAgentRun, appendRecord, readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDispatch, freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const agentRun = {
  at: "x",
  name: "architect",
  role: "architect",
  rung: "claude:claude-opus-5-5#high",
  agent: "a",
  secs: 60,
  status: "ok" as const,
};

describe("spend", () => {
  it("counts minutes by the wall clock since run_start, not by summed role seconds", async () => {
    const { run } = freshRun();
    await appendRecord(run, makeRecord({ dispatchId: "D1", secs: 60 }));
    const in30 = Date.parse(run.meta.createdAt) + 30 * 60_000;
    expect(spendOf(run, readRecords(run).records, [], in30).minutes).toBe(30);
  });

  it("sums tokens and dollars over records, reported subagents and live roles", async () => {
    const { run } = freshRun();
    await appendRecord(
      run,
      makeRecord({ dispatchId: "D1", tokens: { input: 100, cached: 50, output: 10 }, costUsd: 0.5 }),
    );
    appendAgentRun(run, { ...agentRun, totalTokens: 1000, costUsd: 1.25 });
    const live = await fakeDispatch(
      run,
      { name: "w2" },
      { proc: "self", events: readFileSync(join(FX, "two-turns.jsonl"), "utf8") },
    );
    expect(liveTokens(live)).toBe(330);
    const s = spendOf(run, readRecords(run).records, [live], Date.now());
    expect(s.tokens).toBe(110 + 1000 + 330);
    expect(s.usd).toBe(1.75);
    expect(budgetOf(run, { tokens: 1440 }, Date.now())?.fraction).toBe(1);
    expect(budgetOf(run, {}, Date.now())).toBeNull();
  });
});

describe("readyAdapter", () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isCatherdError(e) ? { code: e.code, fix: e.fix } : { code: String(e), fix: undefined };
    }
    return { code: "no error", fix: undefined };
  };

  it("returns a ready Codex with its version, and keeps that answer", async () => {
    resetReadiness();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ version: "0.160.1" }).env);
    const a = await readyAdapter("codex");
    expect(a.adapter.id).toBe("codex");
    expect(a.probe.version).toBe("0.160.1");
    Object.assign(process.env, withScenario({ loggedIn: false }).env);
    expect((await readyAdapter("codex")).probe).toBe(a.probe);
  });

  it("refuses a backend with no adapter, and a CLI that is logged out or too old, with its fix", async () => {
    resetReadiness();
    process.env.PATH = simPath();
    expect((await code(readyAdapter("opencode"))).code).toBe("E_BACKEND_MISSING");
    Object.assign(process.env, withScenario({ loggedIn: false }).env);
    expect(await code(readyAdapter("codex"))).toEqual({
      code: "E_BACKEND_NOT_LOGGED_IN",
      fix: "codex login",
    });
    Object.assign(process.env, withScenario({ version: "0.100.0" }).env);
    expect((await code(readyAdapter("codex"))).code).toBe("E_BACKEND_TOO_OLD");
    process.env.PATH = "/nonexistent";
    expect((await code(readyAdapter("codex"))).code).toBe("E_BACKEND_MISSING");
  });
});

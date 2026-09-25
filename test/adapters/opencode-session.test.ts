import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FinishedRun, Outcome } from "../../src/adapters/backend.ts";
import { opencodeAdapter, opencodeShell } from "../../src/adapters/opencode/index.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type OpencodeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";

const SES = "ses_f2671cde4ffe4VbeG6dKWzM2vi";

afterEach(snapshotEnv());
beforeEach(() => {
  opencodeShell.timeoutMs = 15_000;
});

function onSim(s: OpencodeScenario) {
  withHome();
  process.env.PATH = simPath();
  Object.assign(process.env, withOpencodeScenario(s).env);
}

describe("opencode busy and interrupt", () => {
  it("is busy while the service runs the session", async () => {
    onSim({ active: { [SES]: { type: "running" } } });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(true);
    onSim({ active: {} });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(false);
  });

  it("is not busy when the API fails, prints nothing, or times out", async () => {
    onSim({ apiFails: true, active: { [SES]: { type: "running" } } });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(false);
    opencodeShell.timeoutMs = 200;
    onSim({ apiHangMs: 5_000, active: { [SES]: { type: "running" } } });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(false);
  });

  it("is not busy while it only waits out a usage limit", async () => {
    onSim({
      active: { [SES]: { type: "running" } },
      messages: [
        {
          type: "assistant",
          retry: { attempt: 3, error: { type: "provider.rate-limit", message: "slow down" } },
        },
      ],
    });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(false);
  });

  it("interrupts the session on the service", async () => {
    const to = join(mkdtempSync(join(tmpdir(), "catherd-int-")), "ids");
    onSim({ interruptsTo: to });
    await opencodeAdapter.interrupt?.(SES, "/repo");
    expect(readFileSync(to, "utf8")).toBe(`${SES}\n`);
  });
});

describe("opencode settle", () => {
  const o: Outcome = {
    status: "ok",
    thread: SES,
    tokens: { input: 6505, cached: 488, output: 41 },
    costUsd: 0,
    images: [],
    error: null,
    reply: "DONE",
  };
  const run = {} as FinishedRun;
  const none = { tokens: { input: 0, cached: 0, output: 0 }, costUsd: 0 };

  it("takes the session's totals, less what earlier records counted", async () => {
    // the totals of the real catherd-ro capture (ro-denied.jsonl): the stream said 4271/2419/170
    onSim({
      session: {
        cost: 0.9,
        tokens: { input: 1933, output: 316, reasoning: 231, cache: { read: 5353, write: 0 } },
        outcome: "succeeded",
      },
    });
    expect(await opencodeAdapter.settle?.(o, run, none)).toMatchObject({
      tokens: { input: 7286, cached: 5353, output: 547 },
      costUsd: 0.9,
    });
    const s = await opencodeAdapter.settle?.(o, run, {
      tokens: { input: 5000, cached: 4000, output: 100 },
      costUsd: 0.4,
    });
    expect(s?.tokens).toEqual({ input: 2286, cached: 1353, output: 447 });
    expect(s?.costUsd).toBeCloseTo(0.5);
  });

  it("turns a run stopped while retrying on a usage limit into a limit", async () => {
    onSim({
      messages: [{ type: "assistant", retry: { error: { type: "provider.quota", message: "Go limit" } } }],
    });
    const s = await opencodeAdapter.settle?.(
      { ...o, status: "timeout", error: { code: "timeout", message: "idle" } },
      run,
      none,
    );
    expect(s).toMatchObject({ status: "limit", error: { code: "limit", message: "Go limit" } });
  });

  it("keeps the stream's figures when the API fails", async () => {
    onSim({ apiFails: true });
    expect(await opencodeAdapter.settle?.(o, run, none)).toEqual(o);
  });
});

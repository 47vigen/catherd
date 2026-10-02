import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { coveredMs } from "../../src/domain/util.ts";
import { land } from "../../src/services/lane-service.ts";
import { pauseMachine, resumeMachine } from "../../src/services/pause.ts";
import { answer, park } from "../../src/services/questions.ts";
import { appendAgentRun, createRun, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, passGate } from "./helpers.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-10-02T18:00:00.000Z");
const min = (n: number) => T0 + n * 60_000;
const at = (n: number) => new Date(min(n)).toISOString();

function setup() {
  withHome();
  const repo = tempRepo();
  const run = createRun({ repo, title: "ledger", aLines: ["A1"], version: "t", now: new Date(T0) });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const landing = { run: run.id, milestone: "M2", what: "w", commit, evidence: "ok", next: "M3" };
  return { run, landing };
}

it("counts each paused minute once, open spans running to the end", () => {
  expect(coveredMs(0, 100, [])).toBe(0);
  expect(
    coveredMs(0, 100, [
      { from: 10, to: 30 },
      { from: 20, to: 40 },
      { from: 90, to: null },
      { from: -50, to: 5 },
    ]),
  ).toBe(5 + 30 + 10);
});

it("lands only on a verifier named exactly verifier-<M>: verifier-M2-pre does not count", async () => {
  const { run, landing } = setup();
  await passGate(run, "M2", at(1));
  // a later failed attempt under a looser name is not M2's verifier either way
  for (const name of ["verifier-M2-pre", "verifier-M2-gate1"])
    appendAgentRun(run, {
      at: at(2),
      name,
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 1,
      costUsd: null,
      secs: 1,
      status: "failed",
      lane: null,
    });
  await expect(land(fakeDeps({ now: () => min(3) }), landing)).resolves.toHaveProperty("minutes", 3);
});

it("refuses a milestone whose only verifier verdicts carry a longer name", async () => {
  const { run, landing } = setup();
  await passGate(run, "M2", at(1));
  // drop the exact row passGate wrote: keep only verifier-M2-gate3
  const agents = runPaths(run.dir).agents;
  writeFileSync(
    agents,
    readFileSync(agents, "utf8")
      .split("\n")
      .filter((l) => !l.includes('"verifier-M2"'))
      .join("\n"),
  );
  appendAgentRun(run, {
    at: at(2),
    name: "verifier-M2-gate3",
    role: "verifier",
    rung: "claude:claude-opus-5-5#low",
    agent: null,
    totalTokens: 1,
    costUsd: null,
    secs: 1,
    status: "ok",
    lane: null,
  });
  await expect(land(fakeDeps({ now: () => min(3) }), landing)).rejects.toMatchObject({
    code: "E_LAND_GATE",
    message: expect.stringContaining("named exactly verifier-M2"),
  });
});

it("leaves the parked night and a machine pause out of the ledger minutes", async () => {
  const { run, landing } = setup();
  let now = min(10);
  const deps = fakeDeps({ now: () => now });
  await park(deps, { run: run.id, milestone: "M2", question: "which bucket?" });
  now = min(10 + 600); // ten hours parked overnight
  await answer(deps, { run: run.id, milestone: "M2", answer: "the EU one" });
  pauseMachine(min(620), "the VPN takes the default route");
  resumeMachine(min(650));
  await passGate(run, "M2", at(660));
  now = min(670);
  // 670 minutes since the run started, less 600 parked and 30 paused
  expect((await land(deps, landing)).minutes).toBe(40);
});

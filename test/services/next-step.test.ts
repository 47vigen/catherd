import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRun } from "../../src/entry/runs-command.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { gateCheck, gatePass } from "../../src/services/gate-service.ts";
import { names, recordAgentRun, result, setNext } from "../../src/services/run-service.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { readNotes } from "../../src/services/state.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { verifierStepView } from "../../src/services/verifier-step.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const exit = (endedAt = new Date().toISOString()) => ({
  code: 0,
  signal: null,
  reason: "exited" as const,
  endedAt,
});

function committed(repo: string): void {
  writeFileSync(join(repo, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], { cwd: repo });
}

describe("state.md's Next never outlives the step it names (plan 22)", () => {
  it("names a role or lane only as a whole word", () => {
    expect(names("dispatch M3.L1 at codex:gpt-6-sol#medium on a fresh thread", "M3.L1")).toBe(true);
    expect(names("then land; worker-M3.L1.", "worker-M3.L1")).toBe(true);
    expect(names("dispatch M3.L10", "M3.L1")).toBe(false);
    expect(names("dispatch worker-M3.L1-fix", "worker-M3.L1")).toBe(false);
    expect(names("dispatch M3.L1.b", "M3.L1")).toBe(false);
  });

  it("result() of the dispatch Next names moves Next to the protocol's step; another leaves it", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps();
    await setNext({ run: run.id, next: "dispatch M1.L1 at codex:gpt-6-sol#medium on a fresh thread" });
    const other = await fakeDispatch(
      run,
      { name: "researcher-1", role: "researcher", lane: null },
      { proc: "dead", exit: exit(), reply: "Map.\nSTATUS: complete — ok", collect: true },
    );
    await finalizeDispatch(run, other);
    await result(deps, { run: run.id, name: "researcher-1" });
    expect(readNotes(run).next).toBe("dispatch M1.L1 at codex:gpt-6-sol#medium on a fresh thread");
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: exit(), reply: "Done.\nSTATUS: complete — ok", collect: true },
    );
    const record = await finalizeDispatch(run, d);
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(readNotes(run).next).toBe(`after worker-M1.L1 (${record.status}): route and preflight M1's lanes`);
  });
});

describe("the verifier's step closes (plan 22)", () => {
  const T0 = Date.parse("2026-10-02T10:00:00.000Z");
  const at = (min: number) => () => T0 + min * 60_000;
  const check = { item: "boot check", command: "bun run boot", paths: ["."] };

  async function stepped() {
    const { repo, run } = freshRun();
    committed(repo);
    await gateCheck(fakeDeps({ now: at(0) }), { run: run.id, ...check });
    return { repo, run };
  }

  it("stays open with its age while nothing ends it, and status shows both", async () => {
    const { run } = await stepped();
    expect(verifierStepView(run, at(12)())).toMatchObject({
      item: "boot check",
      secs: 720,
      open: true,
      closedBy: null,
    });
    const s = summarizeRun(fakeDeps({ now: at(12) }), run);
    expect(formatRun(s)).toContain("  verifier step boot check at 10:00 · 12 min ago · open");
  });

  it("closes on a gate_pass of its item", async () => {
    const { run } = await stepped();
    await gatePass(fakeDeps({ now: at(5) }), { run: run.id, ...check, evidence: "ok" });
    expect(verifierStepView(run, at(6)())).toMatchObject({ open: false, closedBy: "gate_pass" });
    expect(formatRun(summarizeRun(fakeDeps({ now: at(6) }), run)).join("\n")).toContain(
      " · closed (gate_pass)",
    );
  });

  it("closes on a native verifier's record_agent_run, and on a verifier dispatch's record", async () => {
    const { run } = await stepped();
    const deps = fakeDeps({ host: { host: "claude-code", session: null, conflict: null }, now: at(3) });
    recordAgentRun(deps, {
      run: run.id,
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      totalTokens: 10,
    });
    expect(verifierStepView(run, at(4)())?.closedBy).toBe("agent-run");
    const { run: other } = await stepped();
    const d = await fakeDispatch(
      other,
      { name: "verifier-M1", role: "verifier", lane: null },
      { proc: "dead", exit: exit(new Date(at(8)()).toISOString()), reply: "VERDICT: PASS", collect: true },
    );
    await finalizeDispatch(other, d);
    expect(verifierStepView(other, at(9)())?.closedBy).toBe("record");
  });

  it("closes when its owner session is gone: another took the run, or the Claude Code session ended", async () => {
    const { run } = await stepped();
    const dir = join(claudeHome(), "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "s-live" }),
    );
    const live = fakeDeps({
      session: { sessionId: "s-live", hostSessionId: null, socketPath: null, token: null },
      now: () => T0 - 60_000,
    });
    await claimRun(live, run);
    expect(verifierStepView(run, at(2)())?.open).toBe(true);
    // the owner's Claude Code session ends
    expect(verifierStepView(run, at(2)(), () => [])?.closedBy).toBe("owner-gone");
    // another session takes the run after the step began
    const next = fakeDeps({
      session: { sessionId: "s-next", hostSessionId: null, socketPath: null, token: null },
      now: at(5),
    });
    await claimRun(next, run);
    expect(verifierStepView(run, at(6)())?.closedBy).toBe("owner-gone");
  });
});

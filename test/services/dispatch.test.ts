import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, fakeGit, freshRun, waitFor, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const OK_EVENTS = join(FX, "ok-with-reconnect.jsonl");

function setup(s: CodexScenario) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario(s).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { repo, run, deps: fakeDeps() };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-luna#high",
  lane: "M1.L1",
  ...over,
});

describe("dispatch", () => {
  it("launches before any state refresh, so an admitted dispatch never waits on git unlaunched", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "catherd-git-")), "unlaunched");
    const { run, deps } = setup({ reply: "Done.\nSTATUS: complete — ok" });
    const roles = runPaths(run.dir).roles;
    // every git call made while a dispatch is admitted (admit.json) but not launched (no launch.json) is logged
    fakeGit(
      `for a in '${roles}'/*/*/admit.json; do [ -f "$a" ] && [ ! -f "$(dirname "$a")/launch.json" ] && echo "$*" >> '${log}'; done\nexec "$REAL_GIT" "$@"`,
    );
    const { record } = await dispatch(deps, input(run.id, { next: "review M1" }));
    expect(record.status).toBe("ok");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    expect(readNotes(run).next).toBe("review M1");
  });

  it("hands the worker the user's backend credentials at spawn time, never catherd's own secrets", async () => {
    const envTo = join(mkdtempSync(join(tmpdir(), "catherd-env-")), "env.jsonl");
    const { run, deps } = setup({ envTo, reply: "Done.\nSTATUS: complete — ok" });
    Object.assign(process.env, { OPENAI_API_KEY: "sk-user", TYPESAFE_API_KEY: "secret" });
    const { record } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("ok");
    const exec = readFileSync(envTo, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; envKeys: string[] })
      .find((c) => c.args[0] === "exec");
    expect(exec?.envKeys).toContain("OPENAI_API_KEY");
    expect(exec?.envKeys).not.toContain("TYPESAFE_API_KEY");
  });

  it("runs a lane to its record: ok, owned file changed, tokens, reply status and a clean state.md", async () => {
    const { run, deps } = setup({
      eventsFile: OK_EVENTS,
      reply: "Done.\nSTATUS: complete — lane finished",
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record, hints } = await dispatch(deps, input(run.id, { next: "review M1" }));
    expect(record).toMatchObject({
      status: "ok",
      rung: "codex:gpt-6-luna#high",
      changedOwned: ["src/a.ts"],
      violations: [],
      replyStatus: "complete",
      replyWhy: "lane finished",
      thread: "01a0d0d4-d0a6-71a1-983c-82a9169200b4",
      tokens: { input: 898388, cached: 788992, output: 5341 },
      attempt: 1,
      cliVersion: "0.157.0",
      exitCode: 0,
    });
    expect(hints).toEqual([]);
    expect(readRecords(run).records).toHaveLength(1);
    expect(readFileSync(join(run.dir, record.replyPath), "utf8")).toContain("STATUS: complete");
    const state = readFileSync(runPaths(run.dir).state, "utf8");
    expect(state).toContain("Running:\n- none");
    expect(state.trimEnd().split("\n").at(-1)).toBe("Next: review M1");
    expect(readFileSync(runPaths(run.dir).harness, "utf8")).toContain('"firstTurnInput":');
  });

  it("flags an ok run that left its owned files alone, and a write outside the lane", async () => {
    const { run, deps } = setup({
      reply: "x\nSTATUS: complete — ok",
      touch: [{ path: "src/other.ts", content: "x" }],
    });
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record.changedOwned).toEqual([]);
    expect(record.violations).toEqual(["src/other.ts"]);
    expect(hints).toEqual(["climb: unchanged", "violation: src/other.ts"]);
  });

  it("points a failed run at its stderr", async () => {
    const { run, deps } = setup({ eventsFile: join(FX, "turn-failed.jsonl"), exitCode: 1 });
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("failed");
    expect(hints).toEqual([`failed: read ${join("roles", "worker-M1.L1", record.dispatchId, "stderr")}`]);
  });

  it("pauses the run on a usage limit when the rung has no stand-in", async () => {
    const { run, deps } = setup({ eventsFile: join(FX, "limit.jsonl"), exitCode: 1 });
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints).toEqual(["limit: codex hit a usage limit on codex:gpt-6-luna#high"]);
    const last = readFileSync(runPaths(run.dir).state, "utf8").trimEnd().split("\n").at(-1);
    expect(last).toBe("Next: paused: codex usage limit; resume when the user says so");
  });

  it("reports progress while the role runs", async () => {
    const { run, deps } = setup({ delayMs: 600, reply: "x\nSTATUS: complete — ok" });
    const ticks: string[] = [];
    await dispatch(deps, input(run.id), (m) => ticks.push(m));
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toMatch(/^worker-M1\.L1 · codex:gpt-6-luna#high · \d+s/);
  });

  it("keeps the lane's Owns as they were at admission, even if the lane file changes mid-run", async () => {
    const { run, deps } = setup({
      delayMs: 1_000,
      reply: "x\nSTATUS: complete — ok",
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    const pending = dispatch(deps, input(run.id));
    // admit.json is written once admission fixed the Owns; the rewrite must land after that, mid-run
    const d = await waitFor(() => listDispatches(run)[0], 5_000);
    expect(existsSync(dispatchPaths(d.dir).exit)).toBe(false);
    writeLane(run, "M1.L1", ["docs/"]);
    const { record } = await pending;
    expect(record.changedOwned).toEqual(["src/a.ts"]);
  });
});

describe("finalizeDispatch", () => {
  const finished = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

  it("writes one record when two finalizers race, and both return it", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: "dead",
        exit: finished,
        events: readFileSync(OK_EVENTS, "utf8"),
        reply: "ok\nSTATUS: complete — ok",
      },
    );
    const [a, b] = await Promise.all([finalizeDispatch(run, d), finalizeDispatch(run, d)]);
    expect(a).toEqual(b);
    expect(readRecords(run).records).toHaveLength(1);
    expect(readFileSync(runPaths(run.dir).runs, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("finishes a dispatch whose claimer died before writing the record", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: finished, reply: "ok\nSTATUS: complete — ok" },
    );
    writeFileSync(dispatchPaths(d.dir).claim, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(dispatchPaths(d.dir).claim, old, old);
    expect((await finalizeDispatch(run, d)).status).toBe("ok");
    expect(readRecords(run).records).toHaveLength(1);
  });

  it("records a dispatch whose supervisor vanished without exit.json as a failed, lost run", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { proc: "dead" });
    const r = await finalizeDispatch(run, d);
    expect(r).toMatchObject({ status: "failed", exitCode: null });
  });

  it("still writes the record when git cannot say what changed, marking the changes unknown", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: finished, reply: "ok\nSTATUS: complete — ok" },
    );
    fakeGit("exit 128");
    const r = await finalizeDispatch(run, d);
    expect(r).toMatchObject({ status: "ok", changedOwned: [], violations: [], gitUnavailable: true });
    expect(readRecords(run).records).toHaveLength(1);
  });
});

/** A git whose `status` fails on the listed calls (counting from 1) and works otherwise. */
function flakyGitStatus(failOn: (n: number) => boolean, calls = 8): void {
  const count = join(mkdtempSync(join(tmpdir(), "catherd-gitcount-")), "n");
  const fails = Array.from({ length: calls }, (_, k) => k + 1).filter(failOn);
  fakeGit(
    [
      'if [ "$3" = status ]; then',
      `  n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 )); echo $n > '${count}'`,
      `  case " ${fails.join(" ")} " in *" $n "*) exit 128;; esac`,
      "fi",
      'exec "$REAL_GIT" "$@"',
    ].join("\n"),
  );
}

describe("dispatch when git fails after admission", () => {
  it("finishes and hints when state.md cannot be refreshed", async () => {
    const { run, deps } = setup({
      reply: "x\nSTATUS: complete — ok",
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    // 1 admission, 2 state (launched, with next), 3 finalize, 4 state (done)
    flakyGitStatus((n) => n === 2);
    const { record, hints } = await dispatch(deps, input(run.id, { next: "review M1" }));
    expect(record).toMatchObject({ status: "ok", changedOwned: ["src/a.ts"] });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/^state\.md not refreshed: git status failed in /);
    expect(readRecords(run).records).toHaveLength(1);
    // the next note reached state.json despite the failed refresh, and the later refresh shows it
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Next: review M1");
  });

  it("records the run with its changes unknown when git stays broken to the end", async () => {
    const { run, deps } = setup({
      reply: "x\nSTATUS: complete — ok",
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    flakyGitStatus((n) => n >= 2);
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record).toMatchObject({ status: "ok", changedOwned: [], violations: [], gitUnavailable: true });
    expect(hints[0]).toBe("git-unavailable: changed files unknown");
    expect(hints.slice(1)).toHaveLength(1);
    expect(hints[1]).toMatch(/^state\.md not refreshed: /);
  });
});

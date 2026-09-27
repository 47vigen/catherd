import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { awaitsCollect, dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import * as fin from "../../src/services/finalize.ts";
import * as state from "../../src/services/state.ts";
import {
  dispatch,
  type DispatchInput,
  launcher,
  wait,
  watchersSettled,
} from "../../src/services/dispatch-service.ts";
import { listDispatches, liveDispatches } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import { noPosixModes, openModes, snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, fakeGit, freshRun, runRole, waitFor, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
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
    const { record } = await runRole(deps, input(run.id, { next: "review M1" }));
    expect(record.status).toBe("ok");
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    expect(readNotes(run).next).toBe("review M1");
  });

  it.skipIf(noPosixModes)(
    "keeps the run, its dispatch folder, locks and logs private: 0700 dirs, 0600 files (audit S2)",
    async () => {
      const { run, deps } = setup({ reply: "Done.\nSTATUS: complete — ok" });
      const { record } = await runRole(deps, input(run.id));
      expect(record.status).toBe("ok");
      const home = process.env.CATHERD_HOME as string;
      expect([...openModes(join(home, "config")), ...openModes(join(home, "data"))]).toEqual([]);
    },
  );

  it("hands the worker the user's backend credentials at spawn time, never catherd's own secrets", async () => {
    const envTo = join(mkdtempSync(join(tmpdir(), "catherd-env-")), "env.jsonl");
    const { run, deps } = setup({ envTo, reply: "Done.\nSTATUS: complete — ok" });
    Object.assign(process.env, { OPENAI_API_KEY: "sk-user", TYPESAFE_API_KEY: "secret" });
    const { record } = await runRole(deps, input(run.id));
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
    const { record, hints } = await runRole(deps, input(run.id, { next: "review M1" }));
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
    // codex reports usage per exec, not per request: no first-turn figure to log
    expect(existsSync(runPaths(run.dir).harness)).toBe(false);
  });

  it("flags an ok run that left its owned files alone, and a write outside the lane", async () => {
    const { run, deps } = setup({
      reply: "x\nSTATUS: complete — ok",
      touch: [{ path: "src/other.ts", content: "x" }],
    });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.changedOwned).toEqual([]);
    expect(record.violations).toEqual(["src/other.ts"]);
    expect(hints).toEqual(["climb: unchanged", "violation: src/other.ts"]);
  });

  it("points a failed run at its stderr", async () => {
    const { run, deps } = setup({ eventsFile: join(FX, "turn-failed.jsonl"), exitCode: 1 });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("failed");
    expect(hints).toEqual([`failed: read ${join("roles", "worker-M1.L1", record.dispatchId, "stderr")}`]);
  });

  it("pauses the run on a usage limit when the rung has no stand-in", async () => {
    const { run, deps } = setup({ eventsFile: join(FX, "limit.jsonl"), exitCode: 1 });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints).toEqual(["limit: codex hit a usage limit on codex:gpt-6-luna#high"]);
    const last = readFileSync(runPaths(run.dir).state, "utf8").trimEnd().split("\n").at(-1);
    expect(last).toBe("Next: paused: codex usage limit; resume when the user says so");
  });

  it("keeps the lane's Owns as they were at admission, even if the lane file changes mid-run", async () => {
    const { run, deps } = setup({
      delayMs: 1_000,
      reply: "x\nSTATUS: complete — ok",
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    const pending = runRole(deps, input(run.id));
    // admit.json is written once admission fixed the Owns; the rewrite must land after that, mid-run
    const d = await waitFor(() => listDispatches(run)[0], 5_000);
    expect(existsSync(dispatchPaths(d.dir).exit)).toBe(false);
    writeLane(run, "M1.L1", ["docs/"]);
    const { record } = await pending;
    expect(record.changedOwned).toEqual(["src/a.ts"]);
  });
});

/** A file the simulated worker waits for before it exits: the test decides when each worker ends. */
const holdFile = () => join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
const OK = { reply: "Done.\nSTATUS: complete — ok" };
const NOTHING = "nothing to wait for: every dispatch of this run has been collected; dispatch a role first";
const NOTHING_FOR = (n: string) => `${n} has nothing to collect: result(run, "${n}") reads its last record`;
const L2 = { name: "worker-M1.L2", lane: "M1.L2", rung: "codex:gpt-6-sol#medium" };

/** Two lanes whose workers each run until released: M1.L1 at Luna, M1.L2 at Sol medium. */
function twoLanes() {
  const [a, b] = [holdFile(), holdFile()];
  const s = setup({
    byRung: { "gpt-6-luna#high": { ...OK, holdUntil: a }, "gpt-6-sol#medium": { ...OK, holdUntil: b } },
  });
  writeLane(s.run, "M1.L2", ["src/b.ts"]);
  return { ...s, releaseA: () => writeFileSync(a, ""), releaseB: () => writeFileSync(b, "") };
}

describe("dispatch returns at launch, wait collects (plan 9, finding 1)", () => {
  it("returns while the worker still runs, with its name and admission time", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    const out = await dispatch(deps, input(run.id, { next: "review M1" }));
    const d = listDispatches(run)[0];
    expect(out).toEqual({
      dispatched: {
        name: "worker-M1.L1",
        role: "worker",
        rung: "codex:gpt-6-luna#high",
        dispatchId: d?.admit.dispatchId as string,
        admittedAt: d?.admit.admittedAt as string,
      },
      hints: [],
    });
    expect(readExit(d?.dir ?? "")).toBeNull();
    expect(liveDispatches(run).map((x) => x.admit.name)).toEqual(["worker-M1.L1"]);
    expect(readRecords(run).records).toEqual([]);
    expect(readNotes(run).next).toBe("review M1");
    expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("Running:\n- none");
    writeFileSync(release, "");
    const w = await wait(deps, { run: run.id });
    expect(w.records.map((r) => r.record.status)).toEqual(["ok"]);
    expect(w.records[0]?.hints).toEqual(["climb: unchanged"]);
    expect({ started: w.started, running: w.running }).toEqual({ started: [], running: [] });
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Running:\n- none");
  });

  it("has two dispatches issued one after the other live at once; wait returns the first to finish", async () => {
    const { run, deps, releaseA, releaseB } = twoLanes();
    const a = await dispatch(deps, input(run.id));
    const b = await dispatch(deps, input(run.id, L2));
    // each worker runs until the test releases it: the second was admitted while the first still ran
    expect(Date.parse(b.dispatched.admittedAt) - Date.parse(a.dispatched.admittedAt)).toBeLessThan(5_000);
    expect(liveDispatches(run).map((d) => d.admit.name)).toEqual([a, b].map((x) => x.dispatched.name).sort());
    releaseB();
    const first = await wait(deps, { run: run.id });
    expect(first.records.map((r) => r.record.name)).toEqual(["worker-M1.L2"]);
    expect(first.running).toEqual(["worker-M1.L1"]);
    releaseA();
    const second = await wait(deps, { run: run.id });
    expect(second.records.map((r) => r.record.name)).toEqual(["worker-M1.L1"]);
    expect(second.running).toEqual([]);
    expect(readRecords(run).records).toHaveLength(2);
  });

  it("waits for every one of them with all: true", async () => {
    const { run, deps, releaseA, releaseB } = twoLanes();
    await dispatch(deps, input(run.id));
    await dispatch(deps, input(run.id, L2));
    releaseB();
    let done = false;
    const all = wait(deps, { run: run.id, all: true }).then((w) => {
      done = true;
      return w;
    });
    // wait records M1.L2 once it finishes, and goes on waiting for M1.L1
    await waitFor(() => readRecords(run).records.some((r) => r.name === "worker-M1.L2"));
    expect(done).toBe(false);
    releaseA();
    const w = await all;
    expect(w.records.map((r) => r.record.name)).toEqual(["worker-M1.L2", "worker-M1.L1"]);
    expect(w.running).toEqual([]);
  });

  it("returns at once, with a hint, when nothing is uncollected", async () => {
    const { run, deps } = setup(OK);
    expect(await wait(deps, { run: run.id })).toEqual({
      records: [],
      started: [],
      running: [],
      hints: [NOTHING],
    });
    expect((await wait(deps, { run: run.id, names: ["worker-M9.L9"] })).hints).toEqual([
      NOTHING_FOR("worker-M9.L9"),
      NOTHING,
    ]);
  });

  it("keeps the run's other roles in running when the names given have nothing to collect", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    expect(await wait(deps, { run: run.id, names: ["worker-M9.L9"] })).toEqual({
      records: [],
      started: [],
      running: ["worker-M1.L1"],
      hints: [NOTHING_FOR("worker-M9.L9")],
    });
    writeFileSync(release, "");
    expect((await wait(deps, { run: run.id })).records).toHaveLength(1);
  });

  it("lists in running a role that finished but was not collected, and the next wait returns it (I-1)", async () => {
    const { run, deps, releaseA, releaseB } = twoLanes();
    await dispatch(deps, input(run.id));
    const b = await dispatch(deps, input(run.id, L2));
    releaseB();
    await waitFor(() =>
      readExit(listDispatches(run).find((d) => d.admit.dispatchId === b.dispatched.dispatchId)?.dir ?? ""),
    );
    releaseA();
    const first = await wait(deps, { run: run.id, names: ["worker-M1.L1"] });
    expect(first.records.map((r) => r.record.name)).toEqual(["worker-M1.L1"]);
    expect(first.running).toEqual(["worker-M1.L2"]);
    const next = await wait(deps, { run: run.id });
    expect(next.records.map((r) => r.record.name)).toEqual(["worker-M1.L2"]);
    expect(next.running).toEqual([]);
  });

  it("finalizes a role as soon as it exits, and leaves its record for wait to hand back (I-2)", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    writeFileSync(release, "");
    await waitFor(() => readRecords(run).records.length === 1);
    await waitFor(() => readFileSync(runPaths(run.dir).state, "utf8").includes("Running:\n- none"));
    const d = listDispatches(run)[0];
    expect(awaitsCollect(d?.dir ?? "")).toBe(true);
    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
  });

  it("hints and drops a dispatch it cannot finalize, and still returns the others (I-3)", async () => {
    const { run, deps } = setup(OK);
    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
    const files = { proc: "dead" as const, exit, reply: "ok\nSTATUS: complete — ok", collect: true };
    const broken = await fakeDispatch(run, {}, files);
    const fine = await fakeDispatch(run, { name: "writer", role: "writer", lane: null, owns: [] }, files);
    const real = fin.finalizeDispatch;
    const spy = spyOn(fin, "finalizeDispatch").mockImplementation((r, d) =>
      d.admit.dispatchId === broken.admit.dispatchId ? Promise.reject(new Error("disk on fire")) : real(r, d),
    );
    try {
      const w = await wait(deps, { run: run.id, all: true });
      expect(w.records.map((r) => r.record.dispatchId)).toEqual([fine.admit.dispatchId]);
      expect(w.hints).toContain(
        'worker-M1.L1: not finalized: disk on fire; result(run, "worker-M1.L1") reads its record once it has one',
      );
      expect(w.running).toEqual([]);
      expect((await wait(deps, { run: run.id })).hints).toEqual([NOTHING]);
    } finally {
      spy.mockRestore();
    }
  });

  it("puts back what it collected when an error escapes, so the next wait returns it (I-3)", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    writeFileSync(release, "");
    await waitFor(() => readRecords(run).records.length === 1);
    await watchersSettled();
    const spy = spyOn(state, "refreshState").mockImplementation(() => Promise.reject(new Error("no disk")));
    try {
      expect(await wait(deps, { run: run.id }).catch((e: Error) => e.message)).toBe("no disk");
    } finally {
      spy.mockRestore();
    }
    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
  });

  it("stops without collecting when its caller aborts it (I-3)", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    const ac = new AbortController();
    const pending = wait(deps, { run: run.id }, undefined, ac.signal);
    ac.abort();
    writeFileSync(release, "");
    expect((await pending).records).toEqual([]);
    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
  });

  it("puts back what it collected when aborted during its final refresh (N-1)", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    writeFileSync(release, "");
    await waitFor(() => readRecords(run).records.length === 1);
    await watchersSettled();
    const ac = new AbortController();
    const real = state.refreshState;
    const spy = spyOn(state, "refreshState").mockImplementation((r, c) => {
      ac.abort();
      return real(r, c);
    });
    try {
      expect((await wait(deps, { run: run.id }, undefined, ac.signal)).records).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
  });

  it("leaves no collect marker behind when the launch throws (M-4)", async () => {
    const { run, deps } = setup(OK);
    const real = launcher.launch;
    launcher.launch = () => {
      throw new Error("no fork");
    };
    try {
      expect(await dispatch(deps, input(run.id)).catch((e: Error) => e.message)).toBe("no fork");
    } finally {
      launcher.launch = real;
    }
    const d = listDispatches(run)[0];
    expect(d && awaitsCollect(d.dir)).toBe(false);
  });

  it("collects a dispatch that finished while no wait ran, as after a server restart, once", async () => {
    const { run, deps } = setup(OK);
    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
    const files = { proc: "dead" as const, exit, reply: "ok\nSTATUS: complete — ok", collect: true };
    const unrecorded = await fakeDispatch(run, {}, files);
    // one the new server's reconcile recorded first is collected too
    const reconciled = await fakeDispatch(
      run,
      { name: "writer", role: "writer", lane: null, owns: [] },
      files,
    );
    await finalizeDispatch(run, reconciled);
    // one no catherd dispatch launched for a wait (an older build's) is left to reconcile
    await fakeDispatch(
      run,
      { name: "writer-old", role: "writer", lane: null, owns: [] },
      { ...files, collect: false },
    );
    const w = await wait(deps, { run: run.id });
    expect(w.records.map((r) => r.record.dispatchId).sort()).toEqual(
      [unrecorded, reconciled].map((d) => d.admit.dispatchId).sort(),
    );
    expect(w.records.find((r) => r.record.name === "writer")?.record.status).toBe("ok");
    expect(readRecords(run).records).toHaveLength(2);
    expect((await wait(deps, { run: run.id })).records).toEqual([]);
  });

  it("hands a record to one wait only, when two wait at once", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    const both = Promise.all([wait(deps, { run: run.id }), wait(deps, { run: run.id })]);
    writeFileSync(release, "");
    const [x, y] = await both;
    expect([...x.records, ...y.records]).toHaveLength(1);
    expect(readRecords(run).records).toHaveLength(1);
  });

  it("still refuses from dispatch, before anything starts", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    const e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_ADMIT_DUPLICATE");
    expect(listDispatches(run)).toHaveLength(1);
    writeFileSync(release, "");
    expect((await wait(deps, { run: run.id })).records).toHaveLength(1);
  });

  it("reports progress while it waits", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    const ticks: string[] = [];
    const pending = wait(deps, { run: run.id }, (m) => ticks.push(m));
    await waitFor(() => ticks.length > 0);
    writeFileSync(release, "");
    expect((await pending).records).toHaveLength(1);
    expect(ticks[0]).toMatch(/^worker-M1\.L1 · codex:gpt-6-luna#high · \d+s/);
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
    const { record, hints } = await runRole(deps, input(run.id, { next: "review M1" }));
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
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({ status: "ok", changedOwned: [], violations: [], gitUnavailable: true });
    expect(hints[0]).toBe("git-unavailable: changed files unknown");
    expect(hints.slice(1)).toHaveLength(1);
    expect(hints[1]).toMatch(/^state\.md not refreshed: /);
  });
});

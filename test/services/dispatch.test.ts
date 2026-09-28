import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import * as dispatchDir from "../../src/infra/dispatch-dir.ts";
import { awaitsCollect, dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import {
  dispatch,
  type DispatchInput,
  launcher,
  type Settled,
  settledHooks,
  type Stalled,
  stallHooks,
  watchersSettled,
} from "../../src/services/dispatch-service.ts";
import { admit } from "../../src/services/admission.ts";
import { listDispatches, liveDispatches, startLimits } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
import { result } from "../../src/services/run-service.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import { noPosixModes, openModes, snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import {
  deadProcess,
  fakeDeps,
  fakeDispatch,
  fakeGit,
  freshRun,
  runRole,
  waitFor,
  writeLane,
} from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(() => {
  startLimits.graceMs = 30_000;
});
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
    expect(state.trimEnd().split("\n").at(-2)).toBe("Next: review M1");
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
    const last = readFileSync(runPaths(run.dir).state, "utf8").trimEnd().split("\n").at(-2);
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

const read = (deps: ReturnType<typeof fakeDeps>, run: string, name = "worker-M1.L1") =>
  result(deps, { run, name });

describe("dispatch returns at launch; its watcher settles it; result reads it (plan 10)", () => {
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
    await watchersSettled();
    const r = await read(deps, run.id);
    expect(r.record?.status).toBe("ok");
    expect(r.hints).toEqual(["climb: unchanged"]);
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Running:\n- none");
  });

  it("has two dispatches issued one after the other live at once, each recorded as it finishes", async () => {
    const { run, deps, releaseA, releaseB } = twoLanes();
    const a = await dispatch(deps, input(run.id));
    const b = await dispatch(deps, input(run.id, L2));
    // each worker runs until the test releases it: the second was admitted while the first still ran
    expect(Date.parse(b.dispatched.admittedAt) - Date.parse(a.dispatched.admittedAt)).toBeLessThan(5_000);
    expect(liveDispatches(run).map((d) => d.admit.name)).toEqual([a, b].map((x) => x.dispatched.name).sort());
    releaseB();
    await waitFor(() => readRecords(run).records.some((r) => r.name === "worker-M1.L2"));
    expect(liveDispatches(run).map((d) => d.admit.name)).toEqual(["worker-M1.L1"]);
    releaseA();
    await watchersSettled();
    expect(readRecords(run).records.map((r) => r.name)).toEqual(["worker-M1.L2", "worker-M1.L1"]);
  });

  it("settles a role as soon as it exits, and leaves its record unread until result reads it", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    writeFileSync(release, "");
    await waitFor(() => readRecords(run).records.length === 1);
    await waitFor(() => readFileSync(runPaths(run.dir).state, "utf8").includes("Running:\n- none"));
    const d = listDispatches(run)[0] as { dir: string };
    expect(awaitsCollect(d.dir)).toBe(true);
    expect((await read(deps, run.id)).record?.status).toBe("ok");
    expect(awaitsCollect(d.dir)).toBe(false);
  });

  it("runs every settled hook once per dispatch, and a hook that throws stops nothing", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    const seen: string[] = [];
    const bad = () => {
      throw new Error("hook broke");
    };
    const good = (s: Settled) => {
      seen.push(`${s.record.name} ${s.record.status}`);
    };
    settledHooks.add(bad);
    settledHooks.add(good);
    try {
      await dispatch(deps, input(run.id));
      writeFileSync(release, "");
      await watchersSettled();
    } finally {
      settledHooks.delete(bad);
      settledHooks.delete(good);
    }
    expect(seen).toEqual(["worker-M1.L1 ok"]);
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Running:\n- none");
  });

  it("tells the stall hooks, once, when the supervisor reports a stall", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    const seen: string[] = [];
    const hook = (s: Stalled) => {
      seen.push(`${s.d.admit.name} ${s.quietMs}`);
    };
    stallHooks.add(hook);
    try {
      await dispatch(deps, input(run.id));
      const d = listDispatches(run)[0] as { dir: string };
      writeFileSync(dispatchPaths(d.dir).stall, JSON.stringify({ schema: 1, at: "x", quietMs: 450_000 }));
      await waitFor(() => seen.length > 0);
      writeFileSync(release, "");
      await watchersSettled();
    } finally {
      stallHooks.delete(hook);
    }
    expect(seen).toEqual(["worker-M1.L1 450000"]);
  });

  it("keeps the mark when the launch throws: dispatch says so, and the lost record is settled and read (M-4)", async () => {
    const { run, deps } = setup(OK);
    startLimits.graceMs = 300;
    const real = launcher.launch;
    launcher.launch = () => {
      throw new Error("no fork");
    };
    let e: unknown;
    try {
      e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
    } finally {
      launcher.launch = real;
    }
    expect(isCatherdError(e) && e.message).toMatch(/no fork/);
    expect(isCatherdError(e) && e.fix).toMatch(/result\(run, "worker-M1\.L1"\) reads its record, lost/);
    const d = listDispatches(run)[0];
    expect(d && awaitsCollect(d.dir)).toBe(true);
    await watchersSettled();
    expect((await read(deps, run.id)).record).toEqual(
      expect.objectContaining({ status: "failed", exitCode: null }),
    );
  });

  it("records a dispatch whose server died after admitting it, before launching it, at the next start", async () => {
    const { run, deps } = setup(OK);
    startLimits.graceMs = 300;
    // what dispatch had done when its process died: admission only
    const { d } = await admit(deps, run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-luna#high",
      thread: null,
      lane: "M1.L1",
      failoverFrom: null,
    });
    expect(awaitsCollect(d.dir)).toBe(true);
    await (
      await reconcileAll(deps)
    ).done;
    expect((await read(deps, run.id)).record).toEqual(
      expect.objectContaining({ dispatchId: d.admit.dispatchId, status: "failed", exitCode: null }),
    );
  });

  it("marks a record read for one reader, when two read at once", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    writeFileSync(release, "");
    await watchersSettled();
    const d = listDispatches(run)[0] as { dir: string };
    const collects: boolean[] = [];
    const real = dispatchDir.tryCollect;
    const spy = spyOn(dispatchDir, "tryCollect").mockImplementation(async (dir) => {
      const got = await real(dir);
      collects.push(got);
      return got;
    });
    try {
      const [x, y] = await Promise.all([read(deps, run.id), read(deps, run.id)]);
      expect(x.record).toEqual(y.record);
    } finally {
      spy.mockRestore();
    }
    expect(collects.filter(Boolean)).toHaveLength(1);
    expect(awaitsCollect(d.dir)).toBe(false);
  });

  it("still refuses from dispatch, before anything starts", async () => {
    const release = holdFile();
    const { run, deps } = setup({ ...OK, holdUntil: release });
    await dispatch(deps, input(run.id));
    const e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_ADMIT_DUPLICATE");
    expect(listDispatches(run)).toHaveLength(1);
    writeFileSync(release, "");
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
  });
});

describe("reading is a lease: a crash between taking a record and returning it loses nothing (codex P2)", () => {
  const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
  /** A finished, recorded dispatch a reader had taken, as its lease names `owner`: the mark is gone. */
  async function leased(
    run: Parameters<typeof fakeDispatch>[0],
    owner: { pid: number; startTime: string | null },
  ) {
    const d = await fakeDispatch(run, {}, { proc: "dead", exit, reply: "ok\nSTATUS: complete — ok" });
    await finalizeDispatch(run, d);
    writeFileSync(dispatchPaths(d.dir).lease, JSON.stringify(owner));
    return d;
  }

  it("reads a record whose reader died holding its lease, and ends the lease", async () => {
    const { run, deps } = setup(OK);
    const d = await leased(run, { pid: await deadProcess(), startTime: "gone" });
    expect(awaitsCollect(d.dir)).toBe(true);
    expect((await read(deps, run.id)).record?.dispatchId).toBe(d.admit.dispatchId);
    expect(existsSync(dispatchPaths(d.dir).lease)).toBe(false);
    expect(awaitsCollect(d.dir)).toBe(false);
  });

  it("never takes a lease whose owner lives: the record is returned, the lease left alone", async () => {
    const { run, deps } = setup(OK);
    const d = await leased(run, { pid: process.pid, startTime: processStartTime(process.pid) });
    expect((await read(deps, run.id)).record?.dispatchId).toBe(d.admit.dispatchId);
    expect(existsSync(dispatchPaths(d.dir).lease)).toBe(true);
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

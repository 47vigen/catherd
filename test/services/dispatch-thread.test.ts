import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const THREAD = "01a0d0d4-d0a6-71a1-983c-82a9169200b4";
const OK = { eventsFile: join(FX, "ok-with-reconnect.jsonl"), reply: "Done.\nSTATUS: complete — ok" };

function setup(s: CodexScenario = OK) {
  const { run } = freshRun();
  process.env.PATH = simPath();
  const scenario = withScenario(s);
  Object.assign(process.env, scenario.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { run, deps: fakeDeps(), recorded: scenario.recorded };
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

async function refused(p: Promise<unknown>): Promise<{ code: string; message: string; fix?: string }> {
  try {
    await p;
  } catch (e) {
    if (isCatherdError(e)) return { code: e.code, message: e.message, fix: e.fix };
    throw e;
  }
  throw new Error("not refused");
}

describe("dispatch's thread (plan 22: the notice carries the thread)", () => {
  it('resumes the name\'s last thread for thread: "latest"', async () => {
    const { run, deps, recorded } = setup();
    const first = await runRole(deps, input(run.id));
    expect(first.record.thread).toBe(THREAD);
    const again = await runRole(deps, input(run.id, { brief: "Fix the finding", thread: "latest" }));
    expect(again.record.thread).toBe(THREAD);
    const last = listDispatches(run).find((d) => d.admit.dispatchId === again.record.dispatchId);
    expect(last?.admit.thread).toBe(THREAD);
    const args = recorded().args;
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).toContain(THREAD);
  });

  it("refuses a thread the name never ran on in this run, before anything starts", async () => {
    const { run, deps } = setup();
    await runRole(deps, input(run.id));
    const other = "0199c011-1234-7000-8000-00000000beef";
    const e = await refused(dispatch(deps, input(run.id, { thread: other })));
    expect(e.code).toBe("E_ADMIT_THREAD");
    expect(e.message).toBe(`${other} is not a thread of worker-M1.L1 in this run`);
    expect(e.fix).toContain('thread: "latest"');
    expect(e.fix).toContain(THREAD);
    // another name's thread is not this name's
    const theirs = await refused(
      dispatch(deps, input(run.id, { name: "worker-M1.L1-fix", lane: undefined, thread: THREAD })),
    );
    expect(theirs.code).toBe("E_ADMIT_THREAD");
    expect(listDispatches(run)).toHaveLength(1);
    expect(readRecords(run).records).toHaveLength(1);
  });

  it('refuses thread: "latest" for a name with no thread yet, and matches a thread in any case', async () => {
    const { run, deps } = setup();
    const none = await refused(dispatch(deps, input(run.id, { thread: "latest" })));
    expect(none).toMatchObject({
      code: "E_ADMIT_THREAD",
      message: "worker-M1.L1 has no earlier thread in this run",
    });
    await runRole(deps, input(run.id));
    const upper = await runRole(deps, input(run.id, { thread: THREAD.toUpperCase() }));
    expect(upper.record.thread).toBe(THREAD);
  });
});

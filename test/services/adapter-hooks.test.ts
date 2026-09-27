import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter, Outcome } from "../../src/adapters/backend.ts";
import { registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { type AdmitInput, admit, prepareLimits } from "../../src/services/admission.ts";
import { resetReadiness, standInFor } from "../../src/services/backends.ts";
import { roleDir } from "../../src/services/dispatches.ts";
import {
  claimSeams,
  finalizeDispatch,
  settleLimits,
  takeOverStaleClaim,
} from "../../src/services/finalize.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { appendRecord, createRun, readRecords } from "../../src/services/run-store.ts";
import { gitLimits } from "../../src/infra/git.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { deadProcess, fakeDeps, fakeDispatch, freshRun, makeRecord, testView, waitFor } from "./helpers.ts";

afterEach(snapshotEnv());
afterEach(() => {
  unregisterAdapter("cursor");
  claimSeams.beforeTakeover = async () => {};
  settleLimits.timeoutMs = 20_000;
  settleLimits.claimMarginMs = 10_000;
  gitLimits.timeoutMs = 15_000;
  prepareLimits.timeoutMs = 60_000;
});
beforeEach(() => resetReadiness());

const OK: Outcome = {
  status: "ok",
  thread: "th-1",
  tokens: { input: 10, cached: 0, output: 1 },
  costUsd: null,
  images: [],
  error: null,
  reply: "streamed\nSTATUS: complete — from the stream",
};

/** A stand-in backend: "cursor" has no real adapter until 1.1, so the test owns the id. */
function fake(over: Partial<BackendAdapter> = {}): BackendAdapter {
  const a: BackendAdapter = {
    id: "cursor",
    minVersion: "0.0.0",
    probe: async () => ({ installed: true, version: "1.0.0", versionOk: true, loggedIn: true, problems: [] }),
    listModels: async () => [],
    plan: (r) => ({ cmd: "true", args: [], env: {}, cwd: r.repo, stdinPath: r.briefPath }),
    parse: () => ({}),
    finalize: () => ({ ...OK }),
    enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "advisory" },
    errors: { limit: [], tooOld: [] },
    resume: { supported: true, sameAccessOnly: false, threadPattern: /^th-\d+$/ },
    failoverFor: (r) => (r.model.startsWith("go-") ? { ...r, model: r.model.replace("go-", "zen-") } : null),
    graceAfterFinalMs: null,
    ...over,
  };
  registerAdapter(a);
  return a;
}

const input = (over: Partial<AdmitInput> = {}): AdmitInput => ({
  role: "worker",
  name: "worker-1",
  brief: "b",
  rung: "cursor:go-m1#default",
  thread: null,
  lane: null,
  failoverFrom: null,
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "admitted";
}

function setup(failover: Record<string, string> = {}) {
  const { run } = freshRun();
  const view = testView({ failover });
  view.roles.worker = { enabled: true, access: "workspace-write", rungs: ["cursor:go-m1#default"] };
  return { run, deps: fakeDeps({ view }) };
}

describe("the adapter's default stand-in (spec §4.5)", () => {
  it("is the profile's stand-in when there is one, else the adapter's, else none", () => {
    fake();
    expect(standInFor({}, "cursor:go-m1#high")).toBe("cursor:zen-m1#high");
    expect(standInFor({ "cursor:go-m1#high": "codex:gpt-6-sol#high" }, "cursor:go-m1#high")).toBe(
      "codex:gpt-6-sol#high",
    );
    expect(standInFor({}, "cursor:zen-m1#high")).toBeNull();
    expect(standInFor({}, "not a rung")).toBeNull();
  });

  it("passes admission for a ladder rung, and no other rung of that backend does", async () => {
    fake();
    const { run, deps } = setup();
    expect(
      await refusal(
        admit(deps, run, input({ rung: "cursor:zen-m1#default", failoverFrom: "cursor:go-m1#default" })),
      ),
    ).toBe("admitted");
    expect(await refusal(admit(deps, run, input({ name: "w2", rung: "cursor:zen-m9#default" })))).toBe(
      "E_ADMIT_RUNG",
    );
  });

  it("gives way to the profile's own stand-in", async () => {
    fake();
    const { run, deps } = setup({ "cursor:go-m1#default": "codex:gpt-6-sol#high" });
    expect(await refusal(admit(deps, run, input({ rung: "cursor:zen-m1#default" })))).toBe("E_ADMIT_RUNG");
  });
});

describe("prepare", () => {
  it("runs before anything is written, and its refusal leaves no dispatch behind", async () => {
    const seen: unknown[] = [];
    fake({
      prepare: async (r) => {
        seen.push(r);
        throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", "no such variant", { fix: "pick one" });
      },
    });
    const { run, deps } = setup();
    expect(await refusal(admit(deps, run, input()))).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(seen).toEqual([
      {
        rung: { backend: "cursor", model: "go-m1", effort: "default" },
        access: "workspace-write",
        isolated: false,
        repo: run.meta.repo,
      },
    ]);
    expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
  });

  it("resumes a thread in the home it started in, whatever the profile's isolation says now", async () => {
    const seen: { isolated: boolean }[] = [];
    fake({
      prepare: async (r) => {
        seen.push(r);
        throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", "stop here", { fix: "none" });
      },
    });
    const { run, deps } = setup();
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "D0",
        backend: "cursor",
        rung: "cursor:go-m1#default",
        thread: "th-7",
        isolated: true,
      }),
    );
    await refusal(admit(deps, run, input({ thread: "th-7" })));
    await refusal(admit(deps, run, input()));
    // a thread an earlier catherd run started
    const earlier = createRun({ repo: tempRepo(), title: "earlier", aLines: [], version: "x" });
    await appendRecord(
      earlier,
      makeRecord({
        dispatchId: "E0",
        backend: "cursor",
        rung: "cursor:go-m1#default",
        thread: "th-8",
        isolated: true,
      }),
    );
    await refusal(admit(deps, run, input({ thread: "th-8" })));
    expect(seen.map((r) => r.isolated)).toEqual([true, false, true]);
  });

  it("refuses the dispatch when prepare never settles, and writes nothing", async () => {
    prepareLimits.timeoutMs = 50;
    fake({ prepare: () => new Promise(() => {}) });
    const { run, deps } = setup();
    let err: unknown;
    await admit(deps, run, input()).catch((e: unknown) => (err = e));
    expect(isCatherdError(err) && err.toJSON()).toMatchObject({
      code: "E_IO_UNEXPECTED",
      message: expect.stringContaining("50 ms"),
      fix: expect.stringContaining("cursor"),
    });
    expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
  });
});

describe("finalize's overlap window", () => {
  it("counts a lane that ended between this dispatch's admission and its worker's start as another's", async () => {
    const { run } = freshRun();
    const t = Date.parse("2026-09-25T10:00:00.000Z");
    const at = (s: number) => new Date(t + s * 1000).toISOString();
    const done = (endedAt: string) => ({ code: 0, signal: null, reason: "exited" as const, endedAt });
    // B wrote src/b.ts and ended at +1 s; A was admitted at 0 s, its worker only started at +2 s
    const b = await fakeDispatch(
      run,
      { name: "worker-M1.L2", lane: "M1.L2", owns: ["src/b.ts"], admittedAt: at(-10) },
      { proc: "dead", exit: done(at(1)) },
    );
    await finalizeDispatch(run, b);
    const a = await fakeDispatch(run, { admittedAt: at(0) }, { proc: "dead", exit: done(at(5)) });
    const proc = JSON.parse(readFileSync(dispatchPaths(a.dir).proc, "utf8"));
    writeFileSync(dispatchPaths(a.dir).proc, JSON.stringify({ ...proc, startedAt: at(2) }));
    mkdirSync(join(run.meta.repo, "src"), { recursive: true });
    writeFileSync(join(run.meta.repo, "src", "b.ts"), "b");
    expect((await finalizeDispatch(run, a)).violations).toEqual([]);
  });
});

describe("finalize with a streamed reply and a settled session", () => {
  const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
  const dispatchOn = (run: ReturnType<typeof freshRun>["run"], thread: string | null) =>
    fakeDispatch(
      run,
      { backend: "cursor", rung: "cursor:go-m1#default", thread, lane: null, owns: [] },
      { proc: "dead", exit },
    );

  it("writes the adapter's reply to reply.md and takes the STATUS from it", async () => {
    fake();
    const { run } = freshRun();
    const d = await dispatchOn(run, null);
    const r = await finalizeDispatch(run, d);
    expect(readFileSync(dispatchPaths(d.dir).reply, "utf8")).toBe(OK.reply as string);
    expect(r).toMatchObject({ replyStatus: "complete", replyWhy: "from the stream" });
  });

  it("counts only this run's share of a resumed session's totals", async () => {
    let total = { input: 1000, cached: 200, output: 50, cost: 0.5 };
    fake({
      settle: async (o, _run, prior) => ({
        ...o,
        tokens: {
          input: total.input - prior.tokens.input,
          cached: total.cached - prior.tokens.cached,
          output: total.output - prior.tokens.output,
        },
        costUsd: total.cost - prior.costUsd,
      }),
    });
    const { run } = freshRun();
    const first = await finalizeDispatch(run, await dispatchOn(run, null));
    expect(first).toMatchObject({ thread: "th-1", tokens: { input: 1000, cached: 200, output: 50 } });
    total = { input: 1500, cached: 300, output: 80, cost: 0.8 };
    const second = await finalizeDispatch(run, await dispatchOn(run, "th-1"));
    expect(second.tokens).toEqual({ input: 500, cached: 100, output: 30 });
    expect(second.costUsd).toBeCloseTo(0.3);
  });

  describe("a second finalizer while the first still settles (codex P2)", () => {
    const counting = (gate?: Promise<void>) => {
      const n = { finalize: 0, settle: 0 };
      fake({
        finalize: () => {
          n.finalize++;
          return { ...OK };
        },
        settle: async (o) => {
          n.settle++;
          await gate;
          return o;
        },
      });
      return n;
    };
    const claimBy = (d: { dir: string }, pid: number, startTime: string | null) =>
      writeFileSync(dispatchPaths(d.dir).claim, JSON.stringify({ pid, startTime }));

    it("joins this process's finalize in flight: one settle, one record, the same for both", async () => {
      let open = () => {};
      const n = counting(new Promise<void>((r) => (open = r)));
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      const first = finalizeDispatch(run, d);
      await waitFor(() => n.settle === 1);
      const second = finalizeDispatch(run, d);
      open();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      expect(n).toEqual({ finalize: 1, settle: 1 });
      expect(readRecords(run).records).toHaveLength(1);
    });

    it("returns a live claimant's record once it appears, never computing its own", async () => {
      const n = counting();
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      claimBy(d, process.pid, processStartTime(process.pid));
      const pending = finalizeDispatch(run, d);
      const theirs = makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId, name: d.admit.name });
      await appendRecord(run, theirs);
      expect((await pending).dispatchId).toBe(d.admit.dispatchId);
      expect(n.finalize).toBe(0);
    });

    it("takes over at once a claim whose claimant is dead", async () => {
      const n = counting();
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      claimBy(d, await deadProcess(), "gone");
      const started = Date.now();
      expect((await finalizeDispatch(run, d)).status).toBe("ok");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(n.finalize).toBe(1);
    });

    it("takes over a live claim only once settle, the git snapshot's timeout and the margin are past", async () => {
      settleLimits.timeoutMs = 50;
      settleLimits.claimMarginMs = 50;
      gitLimits.timeoutMs = 300;
      const n = counting();
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      claimBy(d, process.pid, processStartTime(process.pid));
      const started = Date.now();
      expect((await finalizeDispatch(run, d)).status).toBe("ok");
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(n.finalize).toBe(1);
    });

    it("serializes the takeover of a stale claim: one computer, never two, never none (codex P2)", async () => {
      const n = counting();
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      claimBy(d, await deadProcess(), "gone");
      const claimed: boolean[] = [];
      // the other waiting process gets there first: it takes the claim over and writes the record
      claimSeams.beforeTakeover = async () => {
        claimSeams.beforeTakeover = async () => {};
        claimed.push(await takeOverStaleClaim(d.dir));
        claimed.push(existsSync(dispatchPaths(d.dir).claim));
        await appendRecord(
          run,
          makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId, name: d.admit.name, secs: 42 }),
        );
      };
      const r = await finalizeDispatch(run, d);
      expect(claimed).toEqual([true, true]);
      expect(r.secs).toBe(42);
      expect(n.finalize).toBe(0);
      expect(readRecords(run).records).toHaveLength(1);
    });

    it("lets only one of two takers of the same stale claim win it", async () => {
      counting();
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      claimBy(d, await deadProcess(), "gone");
      const both = await Promise.all([takeOverStaleClaim(d.dir), takeOverStaleClaim(d.dir)]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(existsSync(dispatchPaths(d.dir).claim)).toBe(true);
    });

    it("returns the original claimant's record when it lands before the taker's own", async () => {
      let open = () => {};
      const n = counting(new Promise<void>((r) => (open = r)));
      const { run } = freshRun();
      const d = await dispatchOn(run, null);
      claimBy(d, await deadProcess(), "gone");
      const taking = finalizeDispatch(run, d);
      await waitFor(() => n.settle === 1);
      const theirs = makeRecord({
        runId: run.id,
        dispatchId: d.admit.dispatchId,
        name: d.admit.name,
        tokens: { input: 7, cached: 0, output: 1 },
      });
      await appendRecord(run, theirs);
      open();
      expect((await taking).tokens.input).toBe(7);
      expect(readRecords(run).records).toHaveLength(1);
    });
  });

  it("keeps the stream's outcome when settle throws or hangs", async () => {
    settleLimits.timeoutMs = 50;
    fake({ settle: () => new Promise(() => {}) });
    const { run } = freshRun();
    expect((await finalizeDispatch(run, await dispatchOn(run, null))).tokens).toEqual(OK.tokens);
    unregisterAdapter("cursor");
    fake({ settle: async () => Promise.reject(new Error("api down")) });
    expect((await finalizeDispatch(run, await dispatchOn(run, null))).tokens).toEqual(OK.tokens);
  });
});

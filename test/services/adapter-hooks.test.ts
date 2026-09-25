import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { BackendAdapter, Outcome } from "../../src/adapters/backend.ts";
import { registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { type AdmitInput, admit, prepareLimits } from "../../src/services/admission.ts";
import { resetReadiness, standInFor } from "../../src/services/backends.ts";
import { roleDir } from "../../src/services/dispatches.ts";
import { finalizeDispatch, settleLimits } from "../../src/services/finalize.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());
afterEach(() => {
  unregisterAdapter("cursor");
  settleLimits.timeoutMs = 20_000;
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
      },
    ]);
    expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
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

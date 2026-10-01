import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter, Outcome } from "../../src/adapters/backend.ts";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { adapterFor, registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { type AdmitInput, admit, prepareLimits } from "../../src/services/admission.ts";
import { probeBackend, readyAdapter, resetReadiness, standInFor } from "../../src/services/backends.ts";
import { accessChecks } from "../../src/services/doctor-access.ts";
import { backendChecks } from "../../src/services/doctor-backends.ts";
import { resolveProfile } from "../../src/domain/profile.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import {
  budgetUsdWarnings,
  isolatedOnlyErrors,
  isolationKeyErrors,
  validateNamed,
} from "../../src/services/profile-store.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { listDispatches, roleDir } from "../../src/services/dispatches.ts";
import {
  claimSeams,
  finalizeDispatch,
  settleLimits,
  takeOverStaleClaim,
} from "../../src/services/finalize.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { appendRecord, createRun, readRecords } from "../../src/services/run-store.ts";
import { gitLimits } from "../../src/infra/git.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { deadProcess, fakeDeps, fakeDispatch, freshRun, makeRecord, testView, waitFor } from "./helpers.ts";

afterEach(snapshotEnv());
afterEach(() => {
  // the fake adapter stands under Cursor's id: put the real one back
  registerAdapter(cursorAdapter);
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
    reportsCost: false,
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

  it("pairs the same Grok or Gemini model on Cursor unless the profile names its own (spec 1.3 §7.3)", () => {
    expect(standInFor({}, "grok:grok-4.7#low")).toBe("cursor:grok-4.7#low");
    expect(standInFor({}, "cursor:grok-4.7#high")).toBe("grok:grok-4.7#high");
    expect(standInFor({ "grok:grok-4.7#low": "codex:gpt-6-sol#high" }, "grok:grok-4.7#low")).toBe(
      "codex:gpt-6-sol#high",
    );
    expect(standInFor({}, "antigravity:gemini-3.8-flash#high")).toBe("cursor:gemini-3.8-flash#high");
    expect(standInFor({}, "cursor:gemini-3.8-flash#high")).toBe("antigravity:gemini-3.8-flash#high");
    const own = { "antigravity:gemini-3.8-flash#high": "codex:gpt-6-luna#high" };
    expect(standInFor(own, "antigravity:gemini-3.8-flash#high")).toBe("codex:gpt-6-luna#high");
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
        network: true,
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

describe("a backend that cannot run or is logged out (spec 1.3 §3.3)", () => {
  /** What Bun's spawn throws for a binary built for another OS (seen on macOS: a Linux ELF). */
  const execFormat = (how: "code" | "message") =>
    how === "code"
      ? Object.assign(new Error("ENOEXEC: unknown error, posix_spawn '/home/u/.grok/bin/grok'"), {
          code: "ENOEXEC",
        })
      : new Error("spawn /home/u/.grok/bin/grok: exec format error");

  it("reports a CLI the OS cannot execute as installed but unable to run, with the reinstall command", async () => {
    for (const how of ["code", "message"] as const) {
      resetReadiness();
      fake({
        install: "curl -fsSL https://example.invalid/install.sh | bash",
        probe: async () => {
          throw execFormat(how);
        },
      });
      const p = await probeBackend(adapterFor("cursor") as BackendAdapter);
      expect(p).toEqual({
        installed: true,
        version: null,
        versionOk: false,
        loggedIn: null,
        problems: [
          {
            code: "E_BACKEND_CANNOT_RUN",
            message: `cursor is installed but cannot run on this OS: ${how === "code" ? "/home/u/.grok/bin/grok" : "exec format error"}`,
            fix: "curl -fsSL https://example.invalid/install.sh | bash",
          },
        ],
      });
      let err: unknown;
      await readyAdapter("cursor").catch((e: unknown) => (err = e));
      expect(isCatherdError(err) && err.code).toBe("E_BACKEND_CANNOT_RUN");
    }
    // any other failure of a probe is not this one
    fake({
      probe: async () => {
        throw new Error("boom");
      },
    });
    expect(probeBackend(adapterFor("cursor") as BackendAdapter)).rejects.toThrow("boom");
  });

  it("shows it in doctor's backend row as cannot run, with the reinstall command", async () => {
    process.env.PATH = "/nonexistent";
    fake({
      probe: async () => {
        throw execFormat("code");
      },
    });
    const rows = await backendChecks(new Map(), []);
    expect(rows.find((r) => r.id === "backend:cursor")).toMatchObject({
      state: "skip",
      word: "cannot run",
      fix: "reinstall cursor for this OS",
    });
  });

  it("refuses a backend whose probe finds it logged out, before anything runs (never a browser login)", async () => {
    let probed = 0;
    fake({
      probe: async () => {
        probed++;
        return {
          installed: true,
          version: "1.0.0",
          versionOk: true,
          loggedIn: false,
          problems: [
            { code: "E_BACKEND_NOT_LOGGED_IN", message: "cursor is not logged in", fix: "cursor login" },
          ],
        };
      },
    });
    const { run, deps } = setup();
    expect(await refusal(admit(deps, run, input()))).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
    // a failing probe is never kept: once logged in, the next dispatch goes
    expect(await refusal(admit(deps, run, input()))).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(probed).toBe(2);
  });
});

describe("doctor's access probes on a new backend (spec 1.3 §3.4)", () => {
  const onIt = [
    resolveProfile({ schema: 1, roles: { worker: { rungs: ["cursor:go-m1#default"] } } }, "p", "claude-code"),
  ];

  it("says a backend with no sandbox runner is not tested, and why, without spending a model turn", async () => {
    fake();
    const rows = await accessChecks(onIt, new Set(["cursor"]));
    expect(rows.filter((r) => r.id === "access:cursor")).toEqual([
      {
        id: "access:cursor",
        label: "cursor worker access",
        state: "skip",
        word: "not tested",
        detail:
          "no way to run a shell in cursor's sandbox without a model turn; the live kit (docs/dev/live-verification.md) runs the five probes as one worker turn",
      },
    ]);
  });

  it("gives a failed probe the sandbox's own fix when its shell names one", async () => {
    withHome();
    process.env.CATHERD_PROBE_DOCKER = "catherd-no-docker-here";
    fake({
      accessShell: async () => ({
        how: "cursor's sandbox",
        run: async (_script, args) =>
          args[0] === locksDir()
            ? { ok: false, out: "", err: "touch: Operation not permitted" }
            : { ok: true, out: "", err: "" },
        close: () => {},
        fixes: { lock: "add it to additionalReadwritePaths in ~/.cursor/sandbox.json" },
      }),
    });
    const row = (await accessChecks(onIt, new Set(["cursor"]))).find((r) => r.id === "access:cursor");
    expect(row).toMatchObject({
      id: "access:cursor",
      state: "warn",
      word: "blocked",
      detail: "in cursor's sandbox, a worker cannot: lock-dir write (touch: Operation not permitted)",
      fix: "lock-dir write: add it to additionalReadwritePaths in ~/.cursor/sandbox.json",
    });
  });
});

describe("an isolated backend's API key (spec 1.3 §8)", () => {
  const isolated = resolveProfile({ schema: 1, harness: { cursor: { isolated: true } } }, "p", "claude-code");
  const MISSING = {
    path: "harness.cursor.isolated",
    message: "an isolated cursor run needs CURSOR_API_KEY, which catherd's environment does not have",
    fix: "export CURSOR_API_KEY=<key>, or catherd profile set harness.cursor.isolated false",
  };

  it("is an error while an isolated backend's key is not set, and nothing once it is or while native", () => {
    fake({ isolationKey: "CURSOR_API_KEY" });
    expect(isolationKeyErrors(isolated, {})).toEqual([MISSING]);
    expect(isolationKeyErrors(isolated, { CURSOR_API_KEY: "k" })).toEqual([]);
    expect(isolationKeyErrors(resolveProfile({ schema: 1 }, "p", "claude-code"), {})).toEqual([]);
    // a backend that isolates without a key of its own
    fake();
    expect(isolationKeyErrors(isolated, {})).toEqual([]);
  });

  it("refuses a save that isolates the backend with no key, naming the export", () => {
    withHome();
    fake({ isolationKey: "CURSOR_API_KEY" });
    delete process.env.CURSOR_API_KEY;
    const r = patchProfile("default", { harness: { cursor: { isolated: true } } }, { host: "claude-code" });
    expect(r.saved).toBe(false);
    expect(r.errors).toContainEqual(MISSING);
    process.env.CURSOR_API_KEY = "key-for-test";
    expect(
      patchProfile("default", { harness: { cursor: { isolated: true } } }, { host: "claude-code" }).saved,
    ).toBe(true);
  });
});

describe("a dollar budget a backend cannot see (spec §4.6)", () => {
  const GO = "cursor:go-m1#default";
  const blind = (b: string, roles: string) => ({
    path: "budget.usd",
    message: `budget.usd will not see ${b}'s spend: ${b} reports no dollar cost (${roles} run on it)`,
    fix: "cap it with budget.tokens or budget.minutes: catherd profile set budget.tokens <n>",
  });
  // the worker and reviewer on the fake backend; the codex roles off, or on (the built-in ladders)
  const onFake = (budget: { usd?: number; tokens?: number }, codexRoles = false) =>
    resolveProfile(
      {
        schema: 1,
        budget,
        roles: {
          worker: { rungs: [GO] },
          reviewer: { rungs: [GO] },
          ...(codexRoles
            ? {}
            : Object.fromEntries(
                ["ui-reviewer", "artist", "writer", "researcher"].map((r) => [r, { enabled: false }]),
              )),
        },
      },
      "p",
      "claude-code",
    );

  it("warns once per backend that reports no cost, naming the enabled roles on it", () => {
    fake();
    expect(budgetUsdWarnings(onFake({ usd: 5 }))).toEqual([blind("cursor", "worker, reviewer")]);
    // codex, the real adapter, reports no dollars either
    expect(budgetUsdWarnings(onFake({ usd: 5 }, true))).toEqual([
      blind("cursor", "worker, reviewer"),
      blind("codex", "ui-reviewer, artist, writer, researcher"),
    ]);
  });

  it("says nothing without budget.usd, for a backend that reports its cost, or for a disabled role", () => {
    fake();
    expect(budgetUsdWarnings(onFake({ tokens: 1000 }, true))).toEqual([]);
    fake({ reportsCost: true });
    expect(budgetUsdWarnings(onFake({ usd: 5 }))).toEqual([]);
    fake();
    const off = resolveProfile(
      { schema: 1, budget: { usd: 5 }, roles: { reviewer: { enabled: false, rungs: [GO] } } },
      "p",
      "claude-code",
    );
    expect(budgetUsdWarnings(off).map((w) => w.message)).not.toContainEqual(
      expect.stringContaining("cursor"),
    );
  });

  it("warns for a failover stand-in on a backend that reports no cost", () => {
    fake();
    const SONNET = "claude-code:claude-sonnet-5-5#high";
    const standIn = resolveProfile(
      {
        schema: 1,
        budget: { usd: 5 },
        failover: { [SONNET]: GO },
        roles: Object.fromEntries([
          ["worker", { rungs: [SONNET] }],
          ...["reviewer", "ui-reviewer", "artist", "writer", "researcher"].map((r) => [
            r,
            { enabled: false },
          ]),
        ]),
      },
      "p",
      "claude-code",
    );
    expect(budgetUsdWarnings(standIn)).toEqual([blind("cursor", "worker")]);
  });

  it("warns for a paired stand-in the profile never names (Grok on a limit runs on Cursor)", () => {
    fake();
    const grok = resolveProfile(
      {
        schema: 1,
        budget: { usd: 5 },
        roles: Object.fromEntries([
          ["worker", { rungs: ["grok:grok-4.7#high"] }],
          ...["reviewer", "ui-reviewer", "artist", "writer", "researcher"].map((r) => [
            r,
            { enabled: false },
          ]),
        ]),
      },
      "p",
      "claude-code",
    );
    expect(budgetUsdWarnings(grok)).toEqual([blind("cursor", "worker")]);
  });

  it("never blocks a save, and the save carries the warning", () => {
    withHome();
    const r = patchProfile("default", { budget: { usd: 5 } }, { host: "claude-code" });
    expect([r.saved, r.errors]).toEqual([true, []]);
    const codex = blind("codex", "worker, reviewer, ui-reviewer, artist, writer, researcher");
    expect(r.warnings).toContainEqual(codex);
    // what `profile validate` and doctor's profile row read
    expect(validateNamed("default", null, "claude-code").warnings).toContainEqual(codex);
  });
});

describe("a backend that holds an access only when isolated (spec 1.3 §9 Q2)", () => {
  const reviewerOn = (
    harness: Record<string, { isolated: boolean }>,
    failover: Record<string, string> = {},
  ) =>
    resolveProfile(
      {
        schema: 1,
        roles: { reviewer: { rungs: ["codex:gpt-6-sol#high"] }, writer: { rungs: ["cursor:go-m1#default"] } },
        harness,
        failover,
      },
      "p",
      "claude-code",
    );
  const NATIVE = {
    path: "failover.codex:gpt-6-sol#high",
    message: "cursor:go-m1#default: native cursor cannot hold the reviewer role to read-only",
    fix: "isolate cursor (catherd profile set harness.cursor.isolated true), or put this role on another backend",
  };

  it("is an error for a role at that access on the native harness, a failover stand-in's included", () => {
    fake({ isolatedOnly: ["read-only"] });
    // the writer (workspace-write) runs natively as it likes; the reviewer fails over onto the backend
    expect(isolatedOnlyErrors(reviewerOn({}))).toEqual([]);
    expect(isolatedOnlyErrors(reviewerOn({}, { "codex:gpt-6-sol#high": "cursor:go-m1#default" }))).toEqual([
      NATIVE,
    ]);
    expect(
      isolatedOnlyErrors(
        reviewerOn({ cursor: { isolated: true } }, { "codex:gpt-6-sol#high": "cursor:go-m1#default" }),
      ),
    ).toEqual([]);
    const onIt = resolveProfile(
      { schema: 1, roles: { reviewer: { rungs: ["cursor:go-m1#default"] } } },
      "p",
      "claude-code",
    );
    expect(isolatedOnlyErrors(onIt)).toEqual([{ ...NATIVE, path: "roles.reviewer.rungs" }]);
    fake();
    expect(isolatedOnlyErrors(onIt)).toEqual([]);
  });

  it("counts a paired stand-in the profile does not name (Codex, PR #32)", () => {
    const p = resolveProfile(
      { schema: 1, roles: { reviewer: { rungs: ["cursor:gemini-3.8-flash#high"] } } },
      "p",
      "claude-code",
    );
    expect(isolatedOnlyErrors(p)).toEqual([
      {
        path: "roles.reviewer.rungs",
        message:
          "antigravity:gemini-3.8-flash#high, the automatic stand-in of cursor:gemini-3.8-flash#high: native antigravity cannot hold the reviewer role to read-only",
        fix: "isolate antigravity (catherd profile set harness.antigravity.isolated true), or name another stand-in (catherd profile set failover.cursor:gemini-3.8-flash#high <rung>)",
      },
    ]);
    const named = { ...p, failover: { "cursor:gemini-3.8-flash#high": "codex:gpt-6-sol#high" } };
    expect(isolatedOnlyErrors(named)).toEqual([]);
  });

  it("refuses a save that puts a read-only role on the backend's native harness", () => {
    withHome();
    fake({ isolatedOnly: ["read-only"] });
    const r = patchProfile(
      "default",
      { roles: { reviewer: { rungs: ["cursor:go-m1#default"] } } },
      { host: "claude-code" },
    );
    expect(r.saved).toBe(false);
    expect(r.errors).toContainEqual({ ...NATIVE, path: "roles.reviewer.rungs" });
  });
});

describe("doctor's quota row (spec 1.3 §6.6)", () => {
  it("shows the quota a logged-in backend reports, and nothing when it is logged out or cannot say", async () => {
    process.env.PATH = "/nonexistent";
    let asked = 0;
    const quota = async () => {
      asked++;
      return "Weekly quota: 62% left";
    };
    fake({ quota });
    expect((await backendChecks(new Map(), [])).find((r) => r.id === "quota:cursor")).toEqual({
      id: "quota:cursor",
      label: "cursor quota",
      state: "info",
      word: "quota",
      detail: "Weekly quota: 62% left",
    });
    const loggedOut = { installed: true, version: "1.0.0", versionOk: true, loggedIn: false, problems: [] };
    fake({ quota, probe: async () => loggedOut });
    expect((await backendChecks(new Map(), [])).some((r) => r.id === "quota:cursor")).toBe(false);
    expect(asked).toBe(1);
    fake({
      quota: async () => {
        throw new Error("no answer");
      },
    });
    expect((await backendChecks(new Map(), [])).some((r) => r.id === "quota:cursor")).toBe(false);
  });
});

describe("a backend that keeps a thread's access (spec 1.3 §3.2)", () => {
  const KEEPS = { supported: true, sameAccessOnly: true, threadPattern: /^th-\d+$/ };

  it("refuses to resume a thread under another access before anything runs, and resumes it under the same", async () => {
    const seen: unknown[] = [];
    fake({ resume: KEEPS, prepare: async (r) => void seen.push(r) });
    const { run, deps } = setup();
    deps.view.roles.reviewer = { enabled: true, access: "read-only", rungs: ["cursor:go-m1#default"] };
    await appendRecord(
      run,
      makeRecord({ dispatchId: "D0", backend: "cursor", rung: "cursor:go-m1#default", thread: "th-7" }),
    );
    let err: unknown;
    await admit(deps, run, input({ role: "reviewer", name: "reviewer-1", thread: "th-7" })).catch(
      (e: unknown) => (err = e),
    );
    expect(isCatherdError(err) && err.toJSON()).toEqual({
      code: "E_ADMIT_THREAD",
      message:
        "cursor keeps the access a thread started with: th-7 ran workspace-write, and the reviewer role runs read-only",
      fix: "dispatch a fresh thread (omit `thread`)",
    });
    expect(seen).toEqual([]);
    expect(existsSync(roleDir(run, "reviewer-1"))).toBe(false);
    expect(await refusal(admit(deps, run, input({ thread: "th-7" })))).toBe("admitted");
    // a thread catherd has no record of is the backend's to refuse
    expect(await refusal(admit(deps, run, input({ name: "w2", thread: "th-9" })))).toBe("admitted");
  });

  it("refuses to resume a thread under another network grant before anything runs", async () => {
    const seen: unknown[] = [];
    fake({ resume: KEEPS, prepare: async (r) => void seen.push(r) });
    const { run, deps } = setup();
    deps.view.roles.worker = { ...deps.view.roles.worker!, network: false };
    const on = { backend: "cursor", rung: "cursor:go-m1#default" };
    await appendRecord(run, makeRecord({ ...on, dispatchId: "D0", thread: "th-7", network: true }));
    let err: unknown;
    await admit(deps, run, input({ thread: "th-7" })).catch((e: unknown) => (err = e));
    expect(isCatherdError(err) && err.toJSON()).toEqual({
      code: "E_ADMIT_THREAD",
      message:
        "cursor keeps the network grant a thread started with: th-7 ran with the network, and the worker role runs without it",
      fix: "dispatch a fresh thread (omit `thread`)",
    });
    expect(seen).toEqual([]);
    expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
    // the same grant resumes; a record from before 1.3 carries none to compare
    await appendRecord(run, makeRecord({ ...on, dispatchId: "D1", thread: "th-8", network: false }));
    await appendRecord(run, makeRecord({ ...on, dispatchId: "D2", thread: "th-9" }));
    expect(await refusal(admit(deps, run, input({ name: "w2", thread: "th-8" })))).toBe("admitted");
    expect(await refusal(admit(deps, run, input({ name: "w3", thread: "th-9" })))).toBe("admitted");
  });

  it("writes the role's network grant into admit.json, and finalize copies it to the record", async () => {
    fake();
    const { run, deps } = setup();
    deps.view.roles.worker = { ...deps.view.roles.worker!, network: false };
    await admit(deps, run, input());
    const [d] = listDispatches(run);
    expect(d?.admit.network).toBe(false);
    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
    const done = await fakeDispatch(run, { name: "w9", network: false }, { proc: "dead", exit });
    expect((await finalizeDispatch(run, done)).network).toBe(false);
  });

  it("resumes under any access on a backend that applies each run's own flags", async () => {
    fake();
    const { run, deps } = setup();
    deps.view.roles.reviewer = { enabled: true, access: "read-only", rungs: ["cursor:go-m1#default"] };
    deps.view.roles.worker = { ...deps.view.roles.worker!, network: false };
    await appendRecord(
      run,
      makeRecord({ dispatchId: "D0", backend: "cursor", rung: "cursor:go-m1#default", thread: "th-7" }),
    );
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "D1",
        backend: "cursor",
        rung: "cursor:go-m1#default",
        thread: "th-8",
        network: true,
      }),
    );
    expect(
      await refusal(admit(deps, run, input({ role: "reviewer", name: "reviewer-1", thread: "th-7" }))),
    ).toBe("admitted");
    expect(await refusal(admit(deps, run, input({ thread: "th-8" })))).toBe("admitted");
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

import * as git from "../../src/infra/git.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { type AdmitInput, admit, fullBriefPath } from "../../src/services/admission.ts";
import { claimRunTree } from "../../src/services/run-tree.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { setGateEnv } from "../../src/services/gate-env.ts";
import { latestDispatch } from "../../src/services/dispatches.ts";
import { ownsAdd } from "../../src/services/lane-edit.ts";
import { copyPlanInputs } from "../../src/services/plan-input.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { addKnowledge } from "../../src/services/run-service.ts";
import * as runStore from "../../src/services/run-store.ts";
import { appendRecord, readRecords } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { type OpencodeModel, withOpencodeScenario } from "../sim/sim-scenarios.ts";
import {
  branchRun,
  briefFor,
  fakeDeps,
  fakeDispatch,
  fakeGit,
  freshRun,
  LADDER,
  makeRecord,
  PLAN_TEXT,
  testView,
  writeLane,
} from "./helpers.ts";

const OC_MODELS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "adapters", "opencode", "models.json"), "utf8"),
).data as OpencodeModel[];

afterEach(snapshotEnv());
// a test that needs a backend with no adapter unregisters a real one (plan 17 Ruling X2)
afterEach(() => registerAdapter(opencodeAdapter));
beforeEach(() => {
  resetReadiness();
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const THREAD = "01a0d0d4-d0a6-71a1-983c-82a9169200b4";
const input = (over: Partial<AdmitInput> = {}): AdmitInput => ({
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-luna#high",
  thread: null,
  lane: "M1.L1",
  failoverFrom: null,
  ...over,
});

function setup() {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({}).env, { TYPESAFE_API_KEY: "secret" });
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { repo, run };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "admitted";
}

describe("admission in a worktree (plan 35)", () => {
  it("a role's env names its run tree's compose project (plan 50: one per run)", async () => {
    const { repo, run } = branchRun();
    await claimRunTree(fakeDeps(), run);
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({}).env, { TYPESAFE_API_KEY: "secret" });
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const base = testView();
    const deps = fakeDeps({
      view: testView({
        roles: { ...base.roles, verifier: { enabled: true, access: "read-only", rungs: [LADDER[0]!] } },
      }),
    });
    const envOf = async (over: Partial<AdmitInput>) =>
      JSON.parse(readFileSync((await admit(deps, run, input(over))).specPath, "utf8")).env;
    const name = `catherd-${run.id.slice(0, 15).replace("-", "")}`;
    expect((await envOf({})).COMPOSE_PROJECT_NAME).toBe(name);
    await setGateEnv(repo, "COMPOSE_PROJECT_NAME", { value: "mine" });
    const verifier = {
      role: "verifier" as const,
      name: "verifier-M1",
      lane: null,
      rung: "codex:gpt-6-luna#high",
    };
    expect((await envOf(verifier)).COMPOSE_PROJECT_NAME).toBe("mine");
  });

  it("a role runs with Honcho off, and a gate env value HONCHO_ENABLED=true wins", async () => {
    const { repo, run } = setup();
    const base = testView();
    const deps = fakeDeps({
      view: testView({
        roles: { ...base.roles, verifier: { enabled: true, access: "read-only", rungs: [LADDER[0]!] } },
      }),
    });
    const envOf = async (over: Partial<AdmitInput>) =>
      JSON.parse(readFileSync((await admit(deps, run, input(over))).specPath, "utf8")).env;
    const verifier = {
      role: "verifier" as const,
      name: "verifier-M1",
      lane: null,
      rung: "codex:gpt-6-luna#high",
    };
    expect((await envOf({})).HONCHO_ENABLED).toBe("false");
    expect((await envOf(verifier)).HONCHO_ENABLED).toBe("false");
    await setGateEnv(repo, "HONCHO_ENABLED", { value: "true" });
    expect((await envOf({ ...verifier, name: "verifier-M2" })).HONCHO_ENABLED).toBe("true");
  });

  it("an opencode role gets its scratch TMPDIR", async () => {
    const { run } = setup();
    Object.assign(process.env, withOpencodeScenario({ models: OC_MODELS }).env);
    const rung = "opencode:opencode-go/kimi-k3#max";
    const view = testView();
    view.roles.worker = { enabled: true, access: "workspace-write", rungs: [rung] };
    const { specPath } = await admit(fakeDeps({ view }), run, input({ rung }));
    expect(JSON.parse(readFileSync(specPath, "utf8")).env.TMPDIR).toBe(
      realpathSync(join(run.dir, "scratch", "worker-M1.L1")),
    );
  });

  it("without cwd, admits in the repo as 1.5", async () => {
    const { repo, run } = setup();
    const { d, specPath } = await admit(fakeDeps(), run, input());
    expect([JSON.parse(readFileSync(specPath, "utf8")).cwd, d.admit.repo]).toEqual([repo, repo]);
  });
});

describe("admission", () => {
  it("admits a daemon run's worker with its plan's preamble as context", async () => {
    const { repo, run } = setup();
    const plan = join(repo, "p.md");
    writeFileSync(plan, PLAN_TEXT);
    await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: [plan] });
    copyPlanInputs(run, [plan]);
    const { d } = await admit(fakeDeps(), run, input());
    const brief = readFileSync(dispatchPaths(d.dir).brief, "utf8");
    // plan 44 D12: part 3 is the unit's context (its plan tasks), not the plan's preamble
    expect(brief).toContain(
      "<unit-context>\nYour A-lines:\nA1 it works\n\nRead on demand:\n- plan-input/p.md",
    );
    expect(brief).not.toContain("which applies to every task");
  });

  it("a lane's context comes from its own milestone", async () => {
    const { repo, run } = setup();
    const a = join(repo, "a.md");
    const b = join(repo, "b.md");
    writeFileSync(a, "# Plan A\nGoal: alpha.\n\n## M1 — core\n\n### Task 1: add the store\nDo it.\n");
    writeFileSync(b, "# Plan B\nGoal: beta.\n\n## M2 — docs\n\n### Task 2: docs\nWrite the docs.\n");
    await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: [a, b] });
    copyPlanInputs(run, [a, b]);
    writeLane(run, "M1.L1", ["src/a.ts"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 1\n");
    const { d } = await admit(fakeDeps(), run, input());
    const brief = readFileSync(dispatchPaths(d.dir).brief, "utf8");
    expect(brief).toContain("### Task 1: add the store");
    expect(brief).not.toContain("### Task 2: docs");
  });

  it("a resumed dispatch's brief.md is this round only, and brief-full.md the four parts", async () => {
    const { repo, run } = setup();
    const plan = join(repo, "p.md");
    writeFileSync(plan, PLAN_TEXT);
    await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: [plan] });
    copyPlanInputs(run, [plan]);
    const first = await admit(fakeDeps(), run, input());
    appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: first.d.admit.dispatchId,
        name: "worker-M1.L1",
        thread: THREAD,
      }),
    );
    const again = await admit(fakeDeps(), run, input({ thread: THREAD }));
    const resumed = readFileSync(dispatchPaths(again.d.dir).brief, "utf8");
    expect(resumed).toStartWith("<this-round>\n");
    expect(resumed).not.toContain("<role-contract>");
    expect(readFileSync(fullBriefPath(dispatchPaths(again.d.dir).brief), "utf8")).toStartWith(
      "<role-contract>\n",
    );
  });

  it("puts the role's standing rules in every brief, and no block when the role has none (plan 34)", async () => {
    const { repo, run } = setup();
    const plan = join(repo, "p.md");
    writeFileSync(plan, PLAN_TEXT);
    await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: [plan] });
    copyPlanInputs(run, [plan]);
    await addKnowledge(repo, "always A");
    await addKnowledge(repo, "[worker] only W");
    await addKnowledge(repo, "[reviewer] only R");
    const { d } = await admit(fakeDeps(), run, input());
    const brief = readFileSync(dispatchPaths(d.dir).brief, "utf8");
    const context = brief.slice(brief.indexOf("<unit-context>"), brief.indexOf("</unit-context>"));
    expect(context).toContain("Standing rules for the worker role in this repo (its knowledge.md):");
    expect(context).toContain("always A");
    expect(context).toContain("only W");
    expect(context).not.toContain("only R");
    expect(context.indexOf("Your A-lines")).toBeLessThan(context.indexOf("Standing rules"));

    const other = setup();
    const { d: none } = await admit(fakeDeps(), other.run, input());
    const bare = readFileSync(dispatchPaths(none.dir).brief, "utf8");
    expect(bare).toBe(briefFor(other.run, "Read lanes/M1.L1.md"));
    for (const text of ["The plan's preamble", "Standing rules", "no knowledge recorded"])
      expect(bare).not.toContain(text);
  });

  it("a composed brief is written verbatim", async () => {
    const { run } = setup();
    const brief = "<role-contract>\nX\n</role-contract>\n";
    const { d } = await admit(fakeDeps(), run, input({ brief, composed: true }));
    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toBe(brief);
    // no plan context, standing rules or lane file is added to it
    expect(existsSync(fullBriefPath(dispatchPaths(d.dir).brief))).toBe(false);
  });

  it("a composed resumed dispatch keeps the whole brief beside the trimmed one", async () => {
    const { run } = setup();
    const first = await admit(fakeDeps(), run, input());
    appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: first.d.admit.dispatchId,
        name: "worker-M1.L1",
        thread: THREAD,
      }),
    );
    const brief = "<this-round>\nfix\n</this-round>\n";
    const fullBrief = "<role-contract>\nX\n</role-contract>\n\n<this-round>\nfix\n</this-round>\n";
    const { d } = await admit(fakeDeps(), run, input({ thread: THREAD, brief, fullBrief, composed: true }));
    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toBe(brief);
    expect(readFileSync(fullBriefPath(dispatchPaths(d.dir).brief), "utf8")).toBe(fullBrief);
  });

  it("writes the brief, admit.json, a spec without the brief in argv or catherd's secrets, and the latest pointer", async () => {
    const { repo, run } = setup();
    const { d, specPath } = await admit(
      fakeDeps(),
      run,
      input({ brief: "--help me, do not read me as a flag" }),
    );
    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toBe(
      briefFor(run, "--help me, do not read me as a flag"),
    );
    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toContain(
      `\n\n${replyContract("worker")}\n</role-contract>`,
    );
    // spec 1.5 plan 21: the lane file itself travels in the brief, so an isolated worker never guesses its Owns
    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toContain(
      '<lane-file path="lanes/M1.L1.md">\n# M1.L1 — test lane\nOwns: src/a.ts\nFast check: true\n',
    );
    expect(d.admit).toMatchObject({
      name: "worker-M1.L1",
      owns: ["src/a.ts"],
      rung: "codex:gpt-6-luna#high",
      attempt: 1,
      cliVersion: "0.157.0",
      access: "workspace-write",
      repo,
    });
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    expect(spec.args.at(-1)).toBe("-");
    expect(spec.args.join(" ")).not.toContain("--help me");
    expect(spec.stdinPath).toBe(dispatchPaths(d.dir).brief);
    expect(spec.env.TYPESAFE_API_KEY).toBeUndefined();
    expect(spec.env.PWD).toBe(repo);
    expect(spec).toMatchObject({ idleMs: 15 * 60_000, wallMs: 90 * 60_000, killGraceMs: 10_000 });
    expect(latestDispatch(run, "worker-M1.L1")?.admit.dispatchId).toBe(d.admit.dispatchId);
  });

  it("gives a role its own timeouts over the profile's (plan 23)", async () => {
    const { run } = setup();
    const view = testView();
    const worker = view.roles.worker;
    if (!worker) throw new Error("no worker role");
    view.roles.worker = { ...worker, timeouts: { wallMin: 240 } };
    const { specPath } = await admit(fakeDeps({ view }), run, input());
    expect(JSON.parse(readFileSync(specPath, "utf8"))).toMatchObject({
      idleMs: 15 * 60_000,
      wallMs: 240 * 60_000,
    });
  });

  it("keeps the server's environment out of spec.json, which only its owner can read (spec §10.4)", async () => {
    const { repo, run } = setup();
    process.env.FOO_API_KEY = "s3cret";
    const { specPath } = await admit(fakeDeps(), run, input());
    const text = readFileSync(specPath, "utf8");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("TYPESAFE_API_KEY");
    // the adapter's overrides (a plain codex rung has none), the role's identity and scratch, the dispatch id
    // for catherd lock, its testcontainers session, and PWD
    expect(JSON.parse(text).env).toEqual({
      HONCHO_ENABLED: "false",
      CATHERD_ROLE: `${run.id}/worker-M1.L1`,
      TMPDIR: realpathSync(join(run.dir, "scratch", "worker-M1.L1")),
      CATHERD_DISPATCH_ID: expect.any(String),
      TESTCONTAINERS_SESSION_ID: expect.any(String),
      PWD: repo,
    });
    const env = JSON.parse(text).env;
    expect(env.TESTCONTAINERS_SESSION_ID).toBe(env.CATHERD_DISPATCH_ID);
    expect(statSync(specPath).mode & 0o777).toBe(0o600);
  });

  it("refuses a rung off the ladder, a native Claude rung, a disabled role and a malformed rung", async () => {
    const { run } = setup();
    const deps = fakeDeps();
    expect(await refusal(admit(deps, run, input({ rung: "codex:gpt-6-astra#high" })))).toBe("E_ADMIT_RUNG");
    expect(await refusal(admit(deps, run, input({ rung: "codex:gpt-6-sol" })))).toBe("E_ADMIT_RUNG");
    const claude = await admit(
      deps,
      run,
      input({ role: "architect", name: "architect", lane: null, rung: "claude:claude-opus-5-5#high" }),
    ).catch((e: unknown) => e);
    expect(isCatherdError(claude) && claude.code).toBe("E_ADMIT_RUNG");
    expect(isCatherdError(claude) && claude.fix).toContain(
      'Agent(subagent_type: "catherd-architect-claude-opus-5-5-high")',
    );
    deps.view.roles.writer = { enabled: false, access: "workspace-write", rungs: ["codex:gpt-6-luna#high"] };
    expect(await refusal(admit(deps, run, input({ role: "writer", name: "writer", lane: null })))).toBe(
      "E_ADMIT_RUNG",
    );
  });

  it("accepts a failover stand-in of a ladder rung, and refuses a backend with no adapter", async () => {
    const { run } = setup();
    const deps = fakeDeps({
      view: testView({ failover: { "codex:gpt-6-sol#high": "codex:gpt-6-astra#high" } }),
    });
    expect(await refusal(admit(deps, run, input({ rung: "codex:gpt-6-astra#high" })))).toBe("admitted");
    unregisterAdapter("opencode");
    deps.view.roles.worker?.rungs.push("opencode:auto#default");
    expect(
      await refusal(admit(deps, run, input({ name: "w2", lane: null, rung: "opencode:auto#default" }))),
    ).toBe("E_BACKEND_MISSING");
  });

  it("refuses a bad name, a flag-shaped thread, and a lane without a file or an Owns line", async () => {
    const { run } = setup();
    const deps = fakeDeps();
    expect(await refusal(admit(deps, run, input({ name: "../x" })))).toBe("E_ADMIT_ID");
    expect(
      await refusal(admit(deps, run, input({ thread: "--dangerously-bypass-approvals-and-sandbox" }))),
    ).toBe("E_ADMIT_THREAD");
    expect(await refusal(admit(deps, run, input({ lane: "M9.L9" })))).toBe("E_LANE_INVALID");
    writeLane(run, "M1.L2", []);
    expect(await refusal(admit(deps, run, input({ lane: "M1.L2" })))).toBe("E_LANE_INVALID");
  });

  it("refuses a second live dispatch of a name, and a lane overlapping a live one however it is spelled", async () => {
    const { run } = setup();
    const deps = fakeDeps();
    await fakeDispatch(run, { name: "worker-M1.L1", owns: ["src/"] }, { proc: "self" });
    expect(await refusal(admit(deps, run, input()))).toBe("E_ADMIT_DUPLICATE");
    writeLane(run, "M1.L3", ["./src/a.ts"]);
    expect(await refusal(admit(deps, run, input({ name: "worker-M1.L3", lane: "M1.L3" })))).toBe(
      "E_ADMIT_OVERLAP",
    );
    writeLane(run, "M1.L4", ["test/"]);
    expect(await refusal(admit(deps, run, input({ name: "worker-M1.L4", lane: "M1.L4" })))).toBe("admitted");
  });

  it("lanes in different worktrees never overlap", async () => {
    const { repo, run } = setup();
    // L1 runs in another tree with the same Owns
    await fakeDispatch(
      run,
      { name: "worker-M1.L1", owns: ["src/"], repo: join(repo, "tree-M1") },
      { proc: "self" },
    );
    writeLane(run, "M1.L3", ["src/a.ts"]);
    expect(await refusal(admit(fakeDeps(), run, input({ name: "worker-M1.L3", lane: "M1.L3" })))).toBe(
      "admitted",
    );
  });

  it("refuses a lane overlapping what owns_add granted a running lane since its admission", async () => {
    const { run } = setup();
    const deps = fakeDeps();
    writeLane(run, "M1.L5", ["kit/"]);
    await fakeDispatch(run, { name: "worker-M1.L5", lane: "M1.L5", owns: ["kit/"] }, { proc: "self" });
    await ownsAdd(deps, { run: run.id, lane: "M1.L5", paths: ["src/a_test.ts"], why: "its test" });
    writeLane(run, "M1.L6", ["src/a_test.ts"]);
    expect(await refusal(admit(deps, run, input({ name: "worker-M1.L6", lane: "M1.L6" })))).toBe(
      "E_ADMIT_OVERLAP",
    );
  });

  it("finalizes an exited dispatch nobody waits for before its checks, then admits", async () => {
    const { run } = setup();
    const endedAt = new Date().toISOString();
    const exited = { proc: "dead", exit: { code: 0, signal: null, reason: "exited", endedAt } } as const;
    const a = await fakeDispatch(run, { name: "worker-M1.L9", lane: "M1.L9", owns: ["src/"] }, exited);
    expect(await refusal(admit(fakeDeps(), run, input()))).toBe("admitted");
    expect(readRecords(run).records.filter((r) => r.dispatchId === a.admit.dispatchId)).toHaveLength(1);
  });

  it("keeps a finished dispatch whose record cannot be written blocking its name and lane", async () => {
    const { run } = setup();
    const deps = fakeDeps();
    const endedAt = new Date().toISOString();
    const exited = { proc: "dead", exit: { code: 0, signal: null, reason: "exited", endedAt } } as const;
    await fakeDispatch(run, { name: "worker-M1.L9", lane: "M1.L9", owns: ["src/"] }, exited);
    const failing = spyOn(runStore, "appendRecord").mockRejectedValue(new Error("disk full"));
    try {
      const started = Date.now();
      expect(await refusal(admit(deps, run, input()))).toBe("E_ADMIT_OVERLAP");
      // the failed finalize released its claim: the next one tries at once instead of waiting for a record
      expect(await refusal(admit(deps, run, input({ name: "worker-M1.L9", lane: null })))).toBe(
        "E_ADMIT_DUPLICATE",
      );
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      failing.mockRestore();
    }
    expect(readRecords(run).records).toHaveLength(0);
  });

  it("admits exactly one of two parallel dispatches on overlapping lanes, and one of two with the same name", async () => {
    const { run } = setup();
    const deps = fakeDeps();
    writeLane(run, "M1.L2", ["src/"]);
    const lanes = await Promise.all([
      refusal(admit(deps, run, input())),
      refusal(admit(deps, run, input({ name: "worker-M1.L2", lane: "M1.L2" }))),
    ]);
    expect(lanes.sort()).toEqual(["E_ADMIT_OVERLAP", "admitted"]);
    const names = await Promise.all([
      refusal(
        admit(
          deps,
          run,
          input({ name: "reviewer", role: "reviewer", lane: null, rung: "codex:gpt-6-sol#high" }),
        ),
      ),
      refusal(
        admit(
          deps,
          run,
          input({ name: "reviewer", role: "reviewer", lane: null, rung: "codex:gpt-6-sol#high" }),
        ),
      ),
    ]);
    expect(names.sort()).toEqual(["E_ADMIT_DUPLICATE", "admitted"]);
  });

  it("refuses a new role once the budget is spent, counting what live roles have used so far", async () => {
    const { run } = setup();
    const deps = fakeDeps({ view: testView({ budget: { tokens: 300 } }) });
    await fakeDispatch(
      run,
      { name: "worker-M1.L9", lane: "M1.L9", owns: ["other/"] },
      { proc: "self", events: readFileSync(join(FX, "two-turns.jsonl"), "utf8") },
    );
    expect(await refusal(admit(deps, run, input()))).toBe("E_RUN_BUDGET");
  });

  it("counts attempts per name", async () => {
    const { run } = setup();
    await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "dead" });
    const { d } = await admit(fakeDeps(), run, input());
    expect(d.admit.attempt).toBe(2);
  });

  it("refuses, starting nothing, when git cannot snapshot the tree", async () => {
    const { run } = setup();
    fakeGit("exit 128");
    expect(await refusal(admit(fakeDeps(), run, input()))).toBe("E_IO_UNEXPECTED");
    expect(latestDispatch(run, "worker-M1.L1")).toBeNull();
  });
});

it("does not journal stale ordinary origin after awaited snapshot, but preserves explicit failover origin", async () => {
  const { run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({ reply: "ok" }).env);
  const deps = fakeDeps({
    host: {
      host: "codex",
      session: { host: "codex", sessionId: "old", hostSessionId: null, name: null },
      conflict: null,
    },
  });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const original = git.statusSnapshot;
  const mocked = spyOn(git, "statusSnapshot").mockImplementation(async (repo) => {
    entered();
    await barrier;
    return original(repo);
  });
  try {
    const pending = admit(deps, run, input({ lane: null, name: "ordinary" }));
    await waiting;
    deps.host = { host: "unknown", session: null, conflict: null };
    release();
    const ordinary = await pending;
    expect(ordinary.d.admit.sessionId).toBeUndefined();
    expect(ordinary.d.admit.host).toBeUndefined();
    const explicit = await admit(
      deps,
      run,
      input({ lane: null, name: "failover", sessionId: "origin", host: "codex" }),
    );
    expect(explicit.d.admit).toMatchObject({ sessionId: "origin", host: "codex" });
  } finally {
    release();
    mocked.mockRestore();
  }
});

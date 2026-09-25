import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { type AdmitInput, admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { latestDispatch } from "../../src/services/dispatches.ts";
import { readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, fakeGit, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
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

describe("admission", () => {
  it("writes the brief, admit.json, a spec without the brief in argv or catherd's secrets, and the latest pointer", async () => {
    const { repo, run } = setup();
    const { d, specPath } = await admit(
      fakeDeps(),
      run,
      input({ brief: "--help me, do not read me as a flag" }),
    );
    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toBe("--help me, do not read me as a flag");
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

  it("keeps the server's environment out of spec.json, which only its owner can read (spec §10.4)", async () => {
    const { repo, run } = setup();
    process.env.FOO_API_KEY = "s3cret";
    const { specPath } = await admit(fakeDeps(), run, input());
    const text = readFileSync(specPath, "utf8");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("TYPESAFE_API_KEY");
    // the adapter's overrides and PWD only: a plain codex rung has none
    expect(JSON.parse(text).env).toEqual({ PWD: repo });
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
    deps.view.roles.worker?.rungs.push("opencode:opencode-go/kimi-k3#default");
    expect(
      await refusal(
        admit(deps, run, input({ name: "w2", lane: null, rung: "opencode:opencode-go/kimi-k3#default" })),
      ),
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
    // a rung finalize cannot parse makes its finalize throw
    await fakeDispatch(run, { name: "worker-M1.L9", lane: "M1.L9", owns: ["src/"], rung: "bogus" }, exited);
    const started = Date.now();
    expect(await refusal(admit(deps, run, input()))).toBe("E_ADMIT_OVERLAP");
    // the failed finalize released its claim: the next one tries at once instead of waiting for a record
    expect(await refusal(admit(deps, run, input({ name: "worker-M1.L9", lane: null })))).toBe(
      "E_ADMIT_DUPLICATE",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
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
      { name: "worker-M1.L9", owns: ["other/"] },
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

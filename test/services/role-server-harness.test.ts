import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { newDispatchId } from "../../src/domain/ids.ts";
import { type AdmitInput, admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { appendRecord } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { withClaudeScenario } from "../sim/sim-scenarios.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, makeRecord, testView } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const CODEX = "codex:gpt-6-sol#high";
const CLAUDE = "claude-code:claude-opus-5-5#low";

function setup() {
  const { run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({}).env, withClaudeScenario({}).env);
  const view = testView({ isolated: { codex: true, "claude-code": true } });
  view.roles.verifier = { enabled: true, access: "workspace-write", rungs: [CODEX, CLAUDE] };
  return { run, deps: fakeDeps({ view }) };
}

const verifier = (rung: string, over: Partial<AdmitInput> = {}): AdmitInput => ({
  role: "verifier",
  name: "verifier-M1",
  brief: "verify M1",
  rung,
  thread: null,
  lane: null,
  failoverFrom: null,
  ...over,
});

const spec = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { args: string[]; env: Record<string, string> };

describe("the role server in every harness (spec 1.5 plan 21, #42 findings 1, 2)", () => {
  it("admits an isolated Codex verifier, with the role server under --ignore-user-config", async () => {
    const { run, deps } = setup();
    const { d, specPath } = await admit(deps, run, verifier(CODEX));
    expect(d.admit.isolated).toBe(true);
    const { args } = spec(specPath);
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("mcp_servers.catherd_role.enabled=true");
    expect(args).toContain(
      'mcp_servers.catherd_role.enabled_tools=["read_run_file","read_knowledge","gate_check","gate_pass"]',
    );
  });

  it("admits an isolated Claude Code verifier, isolated piece by piece so its --mcp-config survives", async () => {
    const { run, deps } = setup();
    const { specPath } = await admit(deps, run, verifier(CLAUDE));
    const { args, env } = spec(specPath);
    expect(args).not.toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers.catherd_role.args).toEqual([
      expect.stringMatching(/role-bin\.ts$/),
      "verifier",
      run.id,
    ]);
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__catherd_role__gate_pass");
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  });

  it("resumes a thread an isolated run started, after the user turned isolation off", async () => {
    const { run, deps } = setup();
    const thread = "019a0000-0000-7000-8000-000000000001";
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        dispatchId: newDispatchId(),
        name: "verifier-M1",
        role: "verifier",
        lane: null,
        rung: CODEX,
        backend: "codex",
        thread,
        isolated: true,
      }),
    );
    deps.view.isolated = {};
    const { d, specPath } = await admit(deps, run, verifier(CODEX, { thread }));
    expect(d.admit.isolated).toBe(true);
    expect(spec(specPath).args).toContain("mcp_servers.catherd_role.enabled=true");
  });
});

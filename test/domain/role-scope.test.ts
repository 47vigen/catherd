import { describe, expect, it } from "bun:test";
import {
  COORDINATOR_TOOLS,
  parseRoleScope,
  refusedForRole,
  roleScopeError,
  roleScopeFromEnv,
  roleScopeOfScratch,
} from "../../src/domain/role-scope.ts";

const RUN = "20261002-101500-auth";
const scope = { run: RUN, name: "verifier-M1" };

describe("CATHERD_ROLE (spec 1.5 plan 21)", () => {
  it("reads <run>/<role-name>, and nothing else", () => {
    expect(parseRoleScope(`${RUN}/verifier-M1`)).toEqual(scope);
    for (const bad of [undefined, "", RUN, `${RUN}/`, `/x`, `${RUN}/a/b`, `${RUN}/../x`, `${RUN}/-x`])
      expect(parseRoleScope(bad)).toBeNull();
  });

  it("knows a role by a TMPDIR that is its scratch, when Codex drops CATHERD_ROLE", () => {
    const tmp = `/home/u/.local/share/catherd/repos/app-1a2b3c4d/runs/${RUN}/scratch/verifier-M1`;
    expect(roleScopeOfScratch(tmp)).toEqual(scope);
    expect(roleScopeOfScratch(`${tmp}/`)).toEqual(scope);
    expect(roleScopeOfScratch(`${tmp}/sub/dir`)).toEqual(scope);
    // a plain temp dir, or a folder that only looks like one, is not a role's
    for (const other of [
      undefined,
      "/tmp",
      "/var/folders/x/T/",
      "/home/u/runs/x/scratch/y",
      "/runs/123/scratch/a",
    ])
      expect(roleScopeOfScratch(other)).toBeNull();
    expect(roleScopeFromEnv({ TMPDIR: tmp })).toEqual(scope);
    // CATHERD_ROLE wins over the temp dir
    expect(roleScopeFromEnv({ CATHERD_ROLE: `${RUN}/worker-M1.L1`, TMPDIR: tmp })).toEqual({
      run: RUN,
      name: "worker-M1.L1",
    });
    expect(roleScopeFromEnv({ TMPDIR: "/tmp" })).toBeNull();
  });

  it("refuses every coordinator tool, except a peek of the role's own dispatch and a contract read", () => {
    expect([...COORDINATOR_TOOLS].sort() as string[]).toEqual(
      [
        "answer",
        "cancel",
        "climb",
        "dispatch",
        "land",
        "park",
        "peek",
        "profile_set",
        "result",
        "run_start",
        "set_next",
        "test_push",
        "workspace_child_start",
        "workspace_contract",
        "workspace_start",
        "workspace_budget",
        "workspace_pause",
        "workspace_resume",
      ].sort(),
    );
    for (const tool of COORDINATOR_TOOLS)
      expect(refusedForRole(tool, { run: "other", content: "x" }, scope)).toBe(true);
    expect(refusedForRole("peek", { run: RUN, name: "verifier-M1" }, scope)).toBe(false);
    expect(refusedForRole("peek", { run: RUN }, scope)).toBe(true);
    expect(refusedForRole("peek", { run: RUN, name: "worker-M1.L1" }, scope)).toBe(true);
    expect(refusedForRole("peek", undefined, scope)).toBe(true);
    expect(refusedForRole("workspace_contract", { workspace: "w" }, scope)).toBe(false);
    expect(refusedForRole("workspace_contract", { workspace: "w", content: "x" }, scope)).toBe(true);
    for (const tool of ["status", "read_run_file", "write_run_file", "gate_check", "gate_pass", "route"])
      expect(refusedForRole(tool, { run: RUN }, scope)).toBe(false);
  });

  it("says why, with a fix line", () => {
    const e = roleScopeError("result", scope);
    expect(e.code).toBe("E_ROLE_SCOPE");
    expect(e.message).toBe(`result is the orchestrator's: this process runs verifier-M1 of run ${RUN}`);
    expect(e.fix).toContain(`catherd run-file read ${RUN} <path>`);
  });
});

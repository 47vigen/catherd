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
    expect(roleScopeFromEnv({ TMPDIR: tmp }, { scratch: true })).toEqual(scope);
    // CATHERD_ROLE wins over the temp dir
    expect(roleScopeFromEnv({ CATHERD_ROLE: `${RUN}/worker-M1.L1`, TMPDIR: tmp }, { scratch: true })).toEqual(
      {
        run: RUN,
        name: "worker-M1.L1",
      },
    );
    expect(roleScopeFromEnv({ TMPDIR: "/tmp" }, { scratch: true })).toBeNull();
  });

  it("a CLI shell with only a scratch TMPDIR is no role", () => {
    const tmp = `/home/u/.local/share/catherd/repos/app-1a2b3c4d/runs/${RUN}/scratch/verifier-M1`;
    expect(roleScopeFromEnv({ TMPDIR: tmp })).toBeNull();
    expect(roleScopeFromEnv({ TMPDIR: tmp }, { scratch: true })).toEqual(scope);
  });

  it("refuses every coordinator tool, and only those", () => {
    expect([...COORDINATOR_TOOLS].sort() as string[]).toEqual(
      ["answer", "cancel", "profile", "result", "run_start"].sort(),
    );
    for (const tool of COORDINATOR_TOOLS)
      expect(refusedForRole(tool, { run: "other", content: "x" }, scope)).toBe(true);
    // the reads of a role (its run's files, its gate) are the role server's, not the session's
    for (const tool of [
      "status",
      "read_run_file",
      "write_run_file",
      "gate_check",
      "gate_pass",
      "gate_run",
      "peek",
    ])
      expect(refusedForRole(tool, { run: RUN }, scope)).toBe(false);
  });

  it("says why, with a fix line", () => {
    const e = roleScopeError("result", scope);
    expect(e.code).toBe("E_ROLE_SCOPE");
    expect(e.message).toBe(`result is the orchestrator's: this process runs verifier-M1 of run ${RUN}`);
    expect(e.fix).toContain(`catherd run-file read ${RUN} <path>`);
  });
});

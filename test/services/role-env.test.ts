import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { roleScopeFromEnv } from "../../src/domain/role-scope.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { watchersSettled } from "../../src/services/dispatch-service.ts";
import { noPosixModes, snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

describe("the role's env (spec 1.5 plan 21)", () => {
  it("gives every role CATHERD_ROLE=<run>/<name> and its own scratch as TMPDIR, a write root of its sandbox", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    const sim = withScenario({
      reply: "done\nSTATUS: complete — ok",
      touch: [{ path: "src/a.ts", content: "x" }],
    });
    Object.assign(process.env, sim.env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await runRole(fakeDeps(), {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "do it",
      rung: "codex:gpt-6-luna#high",
      lane: "M1.L1",
    });
    const seen = sim.recorded();
    const scratch = realpathSync(join(run.dir, "scratch", "worker-M1.L1"));
    expect(seen.catherdRole).toBe(`${run.id}/worker-M1.L1`);
    expect(seen.tmpdir).toBe(scratch);
    if (!noPosixModes) expect(statSync(scratch).mode & 0o777).toBe(0o700);
    // the sandbox lets it write there
    const roots = seen.args.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
    expect(JSON.parse(roots!.split("=").slice(1).join("="))).toContain(scratch);
    // and a catherd MCP server its Codex starts, which sees TMPDIR but not CATHERD_ROLE, knows it is that role
    expect(roleScopeFromEnv({ TMPDIR: seen.tmpdir! })).toEqual({ run: run.id, name: "worker-M1.L1" });
    expect(existsSync(join(run.dir, "scratch"))).toBe(true);
  });
});

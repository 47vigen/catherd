import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRun, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { fakeDispatch, freshRun } from "../services/helpers.ts";

afterEach(snapshotEnv());

/** `catherd <args>` as a role's shell runs it: CATHERD_ROLE set, or not, and nothing else of catherd's. */
function catherd(args: string[], o: { role?: string; stdin?: string } = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NO_COLOR: "1",
    ANTHROPIC_API_KEY: "",
  };
  delete env.CATHERD_ROLE;
  if (o.role) env.CATHERD_ROLE = o.role;
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
    env,
    stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("the CLI forms any role can run (spec 1.5 plan 21)", () => {
  it("reads and writes run files, bound by CATHERD_ROLE to the role's own run and its role's operations", async () => {
    const { run } = freshRun();
    const other = createRun({ repo: tempRepo(), title: "other", aLines: ["A1"], version: "0.0.0-test" });
    await fakeDispatch(run, { name: "worker-M1.L1" });
    await fakeDispatch(run, {
      name: "architect",
      role: "architect",
      lane: null,
      owns: [],
      access: "read-only",
    });
    writeFileSync(join(runPaths(run.dir).lanes, "M1.L1.md"), "# M1.L1 — lane\nOwns: src/a.ts\n");
    writeFileSync(join(other.dir, "plan.md"), "secret plan\n");

    // the worker reads its lane, but neither writes nor reads another run
    const worker = `${run.id}/worker-M1.L1`;
    expect(catherd(["run-file", "read", run.id, "lanes/M1.L1.md"], { role: worker })).toMatchObject({
      code: 0,
      out: "# M1.L1 — lane\nOwns: src/a.ts\n",
    });
    const elsewhere = catherd(["run-file", "read", other.id, "plan.md"], { role: worker });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(`error E_ROLE_SCOPE: this process runs worker-M1.L1 of run ${run.id}`);
    const write = catherd(["run-file", "write", run.id, "notes.md"], { role: worker, stdin: "x" });
    expect(write.err).toContain("error E_ROLE_SCOPE: worker-M1.L1 is a worker, which has no write_run_file");

    // the architect writes; catherd's own files stay protected
    const architect = `${run.id}/architect`;
    expect(
      catherd(["run-file", "write", run.id, "plan.md"], { role: architect, stdin: "# Plan\n" }).code,
    ).toBe(0);
    expect(readFileSync(join(run.dir, "plan.md"), "utf8")).toBe("# Plan\n");
    expect(catherd(["run-file", "write", run.id, "state.md"], { role: architect, stdin: "x" }).err).toContain(
      "error E_IO_PATH",
    );
    // a name that is no dispatch of the run gets nothing
    expect(catherd(["run-file", "read", run.id, "plan.md"], { role: `${run.id}/ghost` }).err).toContain(
      "error E_ROLE_SCOPE: ghost is no dispatch of run",
    );
    // the user's own terminal is not a role
    expect(catherd(["run-file", "read", other.id, "plan.md"]).out).toBe("secret plan\n");
  });

  it("checks and records a verifier's gate items, and refuses them to any other role", async () => {
    const { repo, run } = freshRun();
    await fakeDispatch(run, {
      name: "verifier-M1",
      role: "verifier",
      lane: null,
      owns: [],
      access: "read-only",
    });
    await fakeDispatch(run, { name: "worker-M1.L1" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    const gate = ["--item", "unit", "--command", "bun test", "--paths", "a.txt"];
    const verifier = `${run.id}/verifier-M1`;
    const first = catherd(["gate", "check", run.id, ...gate, "--milestone", "M1"], { role: verifier });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual({ carried: false });
    expect(catherd(["gate", "pass", run.id, ...gate, "--evidence", "12 pass"], { role: verifier }).code).toBe(
      0,
    );
    expect(JSON.parse(catherd(["gate", "check", run.id, ...gate], { role: verifier }).out)).toMatchObject({
      carried: true,
    });
    expect(
      catherd(["gate", "pass", run.id, ...gate, "--evidence", "x"], { role: `${run.id}/worker-M1.L1` }).err,
    ).toContain("error E_ROLE_SCOPE: worker-M1.L1 is a worker, which has no gate_pass");
  });
});

import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { snapshotEnv, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function catherd(args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
    env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

it("pauses the machine with a reason, shows it first in status, and resumes it", () => {
  withHome();
  const paused = catherd(["pause", "--machine", "the VPN takes the default route"]);
  expect(paused.code).toBe(0);
  expect(paused.out).toContain("the machine is paused since");
  const shown = catherd(["status"]);
  expect(shown.out.split("\n")[0]).toContain("the VPN takes the default route");
  expect(JSON.parse(catherd(["status", "--json"]).out).paused).toMatchObject([{ scope: "machine" }]);
  expect(catherd(["resume", "--machine"]).out).toContain("resumed: the machine");
  expect(catherd(["resume", "--machine"]).out).toBe("nothing was paused\n");
});

it("refuses a pause that names neither or both of --machine and --workspace", () => {
  withHome();
  const neither = catherd(["pause", "why"]);
  expect(neither.code).not.toBe(0);
  expect(neither.err).toContain("--machine or --workspace");
  expect(catherd(["pause", "--machine", "--workspace", "w", "why"]).code).not.toBe(0);
});

/** `catherd <args>` from a role's shell: CATHERD_ROLE, or its scratch TMPDIR, in `env`. */
function asRole(args: string[], env: Record<string, string>) {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete base.CATHERD_ROLE;
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
    env: { ...base, NO_COLOR: "1", ANTHROPIC_API_KEY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

it("refuses a role's shell a pause or a resume, by CATHERD_ROLE or its scratch TMPDIR, and writes nothing", () => {
  const home = withHome();
  const role = "20260925-120000-app/worker-1";
  const byEnv = asRole(["pause", "--machine", "blocked"], { CATHERD_ROLE: role });
  expect(byEnv.code).toBe(1);
  expect(byEnv.err).toContain("error E_ROLE_SCOPE: catherd pause is the orchestrator's");
  expect(byEnv.err).toContain("fix: report it in your reply; the orchestrator does it");
  const scratch = join(home, "runs", "20260925-120000-app", "scratch", "worker-1");
  const byTmp = asRole(["pause", "--workspace", "w", "blocked"], { TMPDIR: scratch });
  expect(byTmp.code).toBe(1);
  expect(byTmp.err).toContain("E_ROLE_SCOPE");
  expect(JSON.parse(catherd(["status", "--json"]).out).paused ?? []).toEqual([]);
  expect(catherd(["pause", "--machine", "the VPN"]).code).toBe(0);
  const resume = asRole(["resume", "--machine"], { CATHERD_ROLE: role });
  expect(resume.code).toBe(1);
  expect(resume.err).toContain("error E_ROLE_SCOPE: catherd resume is the orchestrator's");
  expect(JSON.parse(catherd(["status", "--json"]).out).paused).toMatchObject([{ scope: "machine" }]);
});

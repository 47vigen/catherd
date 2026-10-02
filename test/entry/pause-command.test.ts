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

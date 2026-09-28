import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dockerSocket, realTmpdir, writableRoots } from "../../src/adapters/access.ts";
import type { RunRequest } from "../../src/adapters/backend.ts";
import { claudeCodeAdapter } from "../../src/adapters/claude-code/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { applyPatch, defaultProfileDoc, patchAt, resolveProfile } from "../../src/domain/profile.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { fakeDeps, freshRun, testView, writeLane } from "../services/helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("codex:gpt-6-sol#high"),
  access: "workspace-write",
  thread: null,
  isolated: false,
  repo: "/repo",
  briefPath: "/d/brief.md",
  replyPath: "/d/reply.md",
  dispatchDir: "/d",
  ...over,
});
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] as string;
const cValues = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

describe("worker access grants (spec §5)", () => {
  it("names the lock dir and the real temp dir as the extra writable roots", () => {
    withHome();
    expect(realTmpdir()).toBe(realpathSync(tmpdir()));
    expect(writableRoots()).toEqual([locksDir(), realpathSync(tmpdir())]);
  });

  it("finds the Docker socket DOCKER_HOST names", () => {
    process.env.DOCKER_HOST = "unix:///tmp/some/docker.sock";
    expect(dockerSocket()).toBe("/tmp/some/docker.sock");
  });

  it("gives a Codex workspace-write worker network and the extra roots, fresh and resumed", () => {
    withHome();
    const roots = `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots())}`;
    for (const thread of [null, "019a-thread-1"]) {
      const c = cValues(codexAdapter.plan(req({ thread })).args);
      expect(c).toContain("sandbox_workspace_write.network_access=true");
      expect(c).toContain(roots);
    }
    const isolated = cValues(codexAdapter.plan(req({ isolated: true })).args);
    expect(isolated).toContain(roots);
  });

  it("drops Codex's network grant for network: false, and grants nothing to read-only or full", () => {
    withHome();
    const off = cValues(codexAdapter.plan(req({ network: false })).args);
    expect(off.some((v) => v.startsWith("sandbox_workspace_write.network_access"))).toBe(false);
    expect(off.some((v) => v.startsWith("sandbox_workspace_write.writable_roots"))).toBe(true);
    for (const access of ["read-only", "full"] as const)
      expect(
        cValues(codexAdapter.plan(req({ access })).args).filter((v) =>
          v.startsWith("sandbox_workspace_write"),
        ),
      ).toEqual([]);
  });

  it("passes headless Claude Code the same grants as sandbox settings", () => {
    withHome();
    process.env.DOCKER_HOST = "unix:///tmp/d.sock";
    const rung = parseRung("claude-code:claude-sonnet-5#high");
    const args = claudeCodeAdapter.plan(req({ rung })).args;
    expect(JSON.parse(after(args, "--settings"))).toEqual({
      sandbox: {
        filesystem: { allowWrite: writableRoots() },
        network: { allowLocalBinding: true, allowUnixSockets: ["/tmp/d.sock"] },
        excludedCommands: ["docker *"],
      },
    });
    const off = claudeCodeAdapter.plan(req({ rung, network: false })).args;
    expect(JSON.parse(after(off, "--settings"))).toEqual({
      sandbox: { filesystem: { allowWrite: writableRoots() } },
    });
    expect(after(off, "--disallowedTools").split(",")).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch", "Bash(git commit *)"]),
    );
    expect(claudeCodeAdapter.plan(req({ rung, access: "read-only" })).args).not.toContain("--settings");
  });

  it("reads and patches roles.<role>.network", () => {
    const doc = applyPatch(defaultProfileDoc(), patchAt("roles.worker.network", "false"));
    const p = resolveProfile(doc, "default");
    expect(p.roles.worker.network).toBe(false);
    expect(p.roles.writer.network).toBeUndefined();
    const back = resolveProfile(applyPatch(doc, patchAt("roles.worker.network", "true")), "default");
    expect(back.roles.worker.network).toBeUndefined();
  });

  it("admission plans a network: false role without the network grant", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({}).env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const view = testView();
    view.roles.worker = { ...(view.roles.worker as NonNullable<typeof view.roles.worker>), network: false };
    const { specPath } = await admit(fakeDeps({ view }), run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-luna#high",
      thread: null,
      lane: "M1.L1",
      failoverFrom: null,
    });
    const args: string[] = JSON.parse(readFileSync(specPath, "utf8")).args;
    expect(args.join(" ")).not.toContain("network_access");
    expect(args.join(" ")).toContain("writable_roots");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dockerSocket,
  dockerSocketCandidates,
  realTmpdir,
  writableRoots,
} from "../../src/adapters/access.ts";
import type { RunRequest } from "../../src/adapters/backend.ts";
import { claudeCodeAdapter, claudeSandboxOn } from "../../src/adapters/claude-code/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { applyPatch, defaultProfileDoc, patchAt, resolveProfile } from "../../src/domain/profile.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
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

  it("takes the lock dir and the Docker socket by their real paths (sandboxes compare real paths)", () => {
    const home = withHome();
    const real = tempDir("catherd-real-");
    const link = join(home, "linked");
    symlinkSync(real, link);
    process.env.CATHERD_HOME = link;
    mkdirSync(locksDir(), { recursive: true });
    expect(writableRoots()[0]).toBe(join(real, "data", "locks"));
    writeFileSync(join(real, "docker.sock"), "");
    process.env.DOCKER_HOST = `unix://${join(link, "docker.sock")}`;
    expect(dockerSocket()).toBe(join(real, "docker.sock"));
  });

  it("grants no local socket for a remote DOCKER_HOST, and else takes the first usual socket that exists", () => {
    const home = tempDir("catherd-sock-");
    for (const host of ["tcp://10.0.0.5:2376", "ssh://me@box", "npipe:////./pipe/docker_engine"]) {
      process.env.DOCKER_HOST = host;
      expect(dockerSocket([join(home, "a.sock")])).toBeNull();
    }
    delete process.env.DOCKER_HOST;
    const [a, b, c] = ["a.sock", "b.sock", "c.sock"].map((f) => join(home, f)) as [string, string, string];
    expect(dockerSocket([a, b, c])).toBeNull();
    writeFileSync(c, "");
    expect(dockerSocket([a, b, c])).toBe(c);
    writeFileSync(b, "");
    expect(dockerSocket([a, b, c])).toBe(b);
    expect(dockerSocketCandidates(home)).toEqual([
      "/var/run/docker.sock",
      join(home, ".orbstack", "run", "docker.sock"),
      join(home, ".docker", "run", "docker.sock"),
      join(home, ".colima", "default", "docker.sock"),
    ]);
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

  it("turns Codex's network off explicitly for network: false, and grants nothing to read-only or full", () => {
    withHome();
    for (const over of [{}, { thread: "019a-thread-1" }, { isolated: true }]) {
      const off = cValues(codexAdapter.plan(req({ network: false, ...over })).args);
      // omitting the override would leave the user's config.toml network_access = true in force
      expect(off).toContain("sandbox_workspace_write.network_access=false");
      expect(off).not.toContain("sandbox_workspace_write.network_access=true");
    }
    const off = cValues(codexAdapter.plan(req({ network: false })).args);
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
      // allowLocalBinding: false outright, so the user's own `true` does not survive the merge
      sandbox: { filesystem: { allowWrite: writableRoots() }, network: { allowLocalBinding: false } },
    });
    expect(after(off, "--disallowedTools").split(",")).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch", "Bash(git commit *)"]),
    );
    expect(claudeCodeAdapter.plan(req({ rung, access: "read-only" })).args).not.toContain("--settings");
  });

  it("keeps the user's sandbox on in --settings, from any of their settings files, so a shallow merge cannot drop it", () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    mkdirSync(join(home, "claude"), { recursive: true });
    const repo = tempDir("catherd-repo-");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const rung = parseRung("claude-code:claude-sonnet-5#high");
    const enabled = () =>
      JSON.parse(after(claudeCodeAdapter.plan(req({ rung, repo })).args, "--settings")).sandbox.enabled;
    const put = (file: string, on: boolean | undefined) =>
      writeFileSync(file, JSON.stringify(on === undefined ? {} : { sandbox: { enabled: on } }));
    expect(enabled()).toBeUndefined();
    for (const file of [
      join(home, "claude", "settings.json"),
      join(repo, ".claude", "settings.json"),
      join(repo, ".claude", "settings.local.json"),
    ]) {
      put(file, true);
      expect([file, enabled()]).toEqual([file, true]);
      expect(claudeSandboxOn(repo)).toBe(true);
      put(file, undefined);
    }
    // Claude Code reads no user-level settings.local.json, so neither does catherd
    put(join(home, "claude", "settings.json"), true);
    put(join(home, "claude", "settings.local.json"), false);
    expect(enabled()).toBe(true);
    put(join(home, "claude", "settings.local.json"), undefined);
    // the most specific file wins: the project's local settings turn the user's sandbox off
    put(join(home, "claude", "settings.json"), true);
    put(join(repo, ".claude", "settings.local.json"), false);
    expect(enabled()).toBeUndefined();
    expect(claudeSandboxOn(repo)).toBe(false);
  });

  it("probes headless Claude Code's shell unsandboxed, and says what to check when its sandbox is on", async () => {
    const home = withHome();
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    const off = await claudeCodeAdapter.accessShell?.({ network: true });
    if (typeof off !== "object") throw new Error("expected a shell");
    expect(off.how).toBe("an unsandboxed shell (Claude Code's sandbox is off)");
    expect((await off.run('printf %s "$1"', ["hi"]))?.out).toBe("hi");
    off.close();
    mkdirSync(join(home, "claude"), { recursive: true });
    writeFileSync(join(home, "claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
    expect(await claudeCodeAdapter.accessShell?.({ network: true })).toContain(
      "sandbox.network.allowedDomains",
    );
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
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(args).not.toContain("sandbox_workspace_write.network_access=true");
    expect(args.join(" ")).toContain("writable_roots");
  });
});

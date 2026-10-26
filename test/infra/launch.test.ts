import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import {
  bunBinary,
  daemonEnv,
  CHECK_ENTRY,
  DAEMON_ENTRY,
  launchDetached,
  launchSupervisor,
  SUPERVISE_ENTRY,
} from "../../src/infra/launch.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { importGraph, SRC } from "../import-graph.ts";

afterEach(snapshotEnv());
// the supervisor and launchSupervisor log (spec §10.2): keep their rows out of the real data dir
beforeEach(() => void withHome());

async function waitFor<T>(f: () => T | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function writeSpec(script: string): { dir: string; spec: string } {
  const dir = mkdtempSync(join(tmpdir(), "catherd-launch-"));
  const spec = join(dir, "spec.json");
  writeJsonAtomic(spec, {
    schema: 1,
    backend: "none",
    dispatchDir: dir,
    cmd: "sh",
    args: ["-c", script],
    env: { PATH: process.env.PATH ?? "" },
    cwd: dir,
    stdinPath: null,
    idleMs: 5000,
    wallMs: 10000,
    killGraceMs: 200,
    graceAfterFinalMs: null,
    pollMs: 20,
  });
  return { dir, spec };
}

describe("launchSupervisor", () => {
  it("returns without waiting for the worker, and the detached supervisor still writes exit.json", async () => {
    const { dir, spec } = writeSpec("sleep 1.5; echo done");
    const t0 = Date.now();
    const pid = launchSupervisor(spec);
    expect(pid).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(1000);
    const exit = await waitFor(() => readExit(dir));
    expect(exit).toMatchObject({ code: 0, reason: "exited" });
    expect(await Bun.file(dispatchPaths(dir).events).text()).toBe("done\n");
  });

  // reads the supervisor's environment from /proc, which macOS does not have
  it.skipIf(!existsSync("/proc/self/environ"))(
    "does not hand catherd's own secrets to the supervisor",
    async () => {
      process.env.TYPESAFE_API_KEY = "catherd-secret";
      process.env.CATHERD_DECISION_KEY = "catherd-secret";
      process.env.CATHERD_LAUNCH_PROBE = "kept";
      const { dir, spec } = writeSpec("sleep 1");
      const pid = launchSupervisor(spec);
      const environ = await waitFor(() => {
        try {
          const e = readFileSync(`/proc/${pid}/environ`, "utf8");
          return e.includes("CATHERD_LAUNCH_PROBE=") ? e : null;
        } catch {
          return null;
        }
      });
      expect(environ).toContain("CATHERD_LAUNCH_PROBE=kept");
      expect(environ).not.toContain("TYPESAFE_API_KEY");
      expect(environ).not.toContain("CATHERD_DECISION_KEY");
      await waitFor(() => readExit(dir));
    },
  );
});

it("scrub_every_boundary removes parent identities through actual detached supervisor and worker", async () => {
  const keys = [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CATHERD_ORCHESTRATION_HOST",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_TOKEN",
  ];
  for (const k of keys) process.env[k] = "parent-identity";
  process.env.OPENAI_API_KEY = "native-credential";
  const { dir, spec } = writeSpec("env");
  const doc = JSON.parse(readFileSync(spec, "utf8"));
  for (const k of keys) doc.env[k] = "override-identity";
  writeJsonAtomic(spec, doc);
  launchSupervisor(spec);
  expect(await waitFor(() => readExit(dir))).toMatchObject({ code: 0 });
  const out = readFileSync(dispatchPaths(dir).events, "utf8");
  for (const k of keys) expect(out).not.toContain(`${k}=`);
  expect(out).toContain(`CODEX_HOME=${process.env.CODEX_HOME}`);
  expect(out).toContain("OPENAI_API_KEY=native-credential");
});

describe("launchDetached and the daemon's launch", () => {
  it("a removed Bun path falls back to the bun on PATH", () => {
    expect(bunBinary("/nonexistent/bun", () => "/opt/bun/bin/bun")).toBe("/opt/bun/bin/bun");
  });

  it("an existing Bun path is the one spawned, whatever PATH holds", () => {
    expect(bunBinary(process.execPath, () => "/opt/bun/bin/bun")).toBe(process.execPath);
  });

  it("starts an entry in its own session, appending its output to the log file, and returns at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-launch-"));
    const entry = join(dir, "entry.ts");
    await Bun.write(entry, 'console.log("hello", process.argv[2]);');
    const log = join(dir, "out.log");
    const pid = launchDetached(entry, ["x"], log, { PATH: process.env.PATH ?? "" });
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => (existsSync(log) && readFileSync(log, "utf8").includes("hello x") ? true : null));
  });

  it("the daemon gets the decision key", () => {
    expect(daemonEnv({ PATH: "/bin", CATHERD_DECISION_KEY: "dk" })).toEqual({
      PATH: "/bin",
      CATHERD_DECISION_KEY: "dk",
    });
  });

  it("gives the daemon the launcher's env without its session identity or any role's scope", () => {
    const env = daemonEnv({
      PATH: "/bin",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CATHERD_ROLE: "r1:worker-M1.L1",
      CATHERD_HOME: "/h",
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: "/bin", CATHERD_HOME: "/h" });
  });
});

describe("the detached entries", () => {
  it.each([
    ["supervise", SUPERVISE_ENTRY, "entry/supervise-bin.ts", "entry/supervise-command.ts"],
    ["daemon", DAEMON_ENTRY, "entry/daemon-bin.ts", null],
    ["check worker", CHECK_ENTRY, "entry/check-bin.ts", null],
  ])("runs a thin %s entry that never reaches the panel, cli.ts or react", (_name, entry, file, uses) => {
    expect(relative(SRC, entry)).toBe(file);
    const g = importGraph(entry);
    if (uses) expect(g.files).toContain(uses);
    expect(g.files.filter((f) => f.startsWith("entry/panel/") || f === "cli.ts")).toEqual([]);
    expect(g.packages.filter((p) => p === "react")).toEqual([]);
  });
});

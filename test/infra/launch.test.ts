import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { launchSupervisor, SUPERVISE_ENTRY } from "../../src/infra/launch.ts";
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
      await waitFor(() => readExit(dir));
    },
  );

  it("runs a thin entry that never reaches the TUI, cli.ts or @opentui", () => {
    expect(relative(SRC, SUPERVISE_ENTRY)).toBe("entry/supervise-bin.ts");
    const g = importGraph(SUPERVISE_ENTRY);
    expect(g.files).toContain("entry/supervise-command.ts");
    expect(g.files.filter((f) => f.startsWith("entry/tui/") || f === "cli.ts")).toEqual([]);
    expect(g.packages.filter((p) => p.startsWith("@opentui") || p === "react")).toEqual([]);
  });
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

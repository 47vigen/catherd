import { afterEach, describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { CatherdError } from "../../src/domain/errors.ts";
import { DAEMON_ENTRY } from "../../src/infra/launch.ts";
import { fileURLToPath } from "node:url";
import { daemonAlive, readHeartbeat, superviseDaemon } from "../../src/services/daemon.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { snapshotEnv, spawnEnv } from "../helpers.ts";
import { importGraph, SRC } from "../import-graph.ts";
import { freshRun, waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

describe("daemon-bin", () => {
  it("runs a thin entry that never reaches the panel, cli.ts or react", () => {
    expect(relative(SRC, DAEMON_ENTRY)).toBe("entry/daemon-bin.ts");
    const g = importGraph(DAEMON_ENTRY);
    expect(g.files.filter((f) => f.startsWith("entry/panel/") || f === "cli.ts")).toEqual([]);
    expect(g.packages.filter((p) => p === "react")).toEqual([]);
  });

  it("takes the run's lock, appends daemon.started and beats", async () => {
    const { run } = freshRun();
    await appendEvent(run, {
      type: "run.started",
      repo: run.meta.repo,
      title: "t",
      aLines: [],
      plan: [],
      base: null,
    });
    // a cancelled run: whatever the daemon goes on to do, it starts no role
    await appendEvent(run, { type: "cancel.requested", by: "owner" });
    const p = Bun.spawn([process.execPath, DAEMON_ENTRY, run.id], {
      env: spawnEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    const types = readEvents(run).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["run.started", "cancel.requested", "daemon.started"]);
    expect(readHeartbeat(run)).toMatchObject({ schema: 1 });
    expect(daemonAlive(run)).toBe(false);
  });

  it("leaves an ended run alone", async () => {
    const { run } = freshRun();
    await appendEvent(run, {
      type: "run.started",
      repo: run.meta.repo,
      title: "t",
      aLines: [],
      plan: [],
      base: null,
    });
    await appendEvent(run, { type: "run.ended", outcome: "cancelled", reportPath: null });
    const p = Bun.spawn([process.execPath, DAEMON_ENTRY, run.id], {
      env: spawnEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started", "run.ended"]);
  });

  it("refuses a run id it does not know", async () => {
    freshRun();
    const p = Bun.spawn([process.execPath, DAEMON_ENTRY, "no-such-run"], {
      env: spawnEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("no run");
  });

  it("a daemon outlives the process that launched it", async () => {
    const { run } = freshRun();
    await appendEvent(run, {
      type: "run.started",
      repo: run.meta.repo,
      title: "t",
      aLines: [],
      plan: [],
      base: null,
    });
    await appendEvent(run, { type: "cancel.requested", by: "owner" });
    const launch = fileURLToPath(new URL("../../src/infra/launch.ts", import.meta.url));
    const src = `import { launchDaemon } from ${JSON.stringify(launch)}; launchDaemon(${JSON.stringify(run.id)}, ${JSON.stringify(run.dir)});`;
    const launcher = Bun.spawn([process.execPath, "-e", src], {
      env: spawnEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    // the launching process is gone before the daemon has done anything
    expect(await launcher.exited).toBe(0);
    await waitFor(() => readEvents(run).some((e) => e.type === "run.ended"));
    expect(readEvents(run).find((e) => e.type === "run.ended")).toMatchObject({ outcome: "cancelled" });
    await waitFor(() => !daemonAlive(run));
  });

  it("a daemon stopped by ENOSPC runs again once there is disk", async () => {
    const free = [10, 5000];
    const sleeps: number[] = [];
    const o = {
      freeMb: () => free.shift() ?? 5000,
      reserveMb: () => 4096,
      sleep: async (ms: number) => void sleeps.push(ms),
      pollMs: 30_000,
    };
    let calls = 0;
    const once = async () => {
      if (++calls === 1) throw new Error("ENOSPC: no space left on device, write");
      return "ended";
    };
    expect(await superviseDaemon(once, o)).toBe("ended");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([30_000]);

    let other = 0;
    const boom = new CatherdError("E_IO_UNEXPECTED", "disk on fire");
    await expect(
      superviseDaemon(async () => {
        other++;
        throw boom;
      }, o),
    ).rejects.toBe(boom);
    expect(other).toBe(1);
  });
});

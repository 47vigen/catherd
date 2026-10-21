import { afterEach, describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { DAEMON_ENTRY } from "../../src/infra/launch.ts";
import { daemonAlive, readHeartbeat } from "../../src/services/daemon.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { importGraph, SRC } from "../import-graph.ts";
import { freshRun } from "../services/helpers.ts";

afterEach(snapshotEnv());

describe("daemon-bin", () => {
  it("runs a thin entry that never reaches the TUI, cli.ts or @opentui", () => {
    expect(relative(SRC, DAEMON_ENTRY)).toBe("entry/daemon-bin.ts");
    const g = importGraph(DAEMON_ENTRY);
    expect(g.files.filter((f) => f.startsWith("entry/tui/") || f === "cli.ts")).toEqual([]);
    expect(g.packages.filter((p) => p.startsWith("@opentui") || p === "react")).toEqual([]);
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
      engine: "2.0",
    });
    // a cancelled run: whatever the daemon goes on to do, it starts no role
    await appendEvent(run, { type: "cancel.requested", by: "owner" });
    const p = Bun.spawn([process.execPath, DAEMON_ENTRY, run.id], {
      env: { ...process.env, ANTHROPIC_API_KEY: "", CATHERD_NO_END_PUSH: "1" },
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
      engine: "2.0",
    });
    await appendEvent(run, { type: "run.ended", outcome: "cancelled", reportPath: null });
    const p = Bun.spawn([process.execPath, DAEMON_ENTRY, run.id], {
      env: { ...process.env, ANTHROPIC_API_KEY: "", CATHERD_NO_END_PUSH: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started", "run.ended"]);
  });

  it("refuses a run id it does not know", async () => {
    freshRun();
    const p = Bun.spawn([process.execPath, DAEMON_ENTRY, "no-such-run"], {
      env: { ...process.env, ANTHROPIC_API_KEY: "", CATHERD_NO_END_PUSH: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("no run");
  });
});

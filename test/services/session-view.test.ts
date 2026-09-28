import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEnv } from "../../src/infra/claude-session.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import { createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { groupRuns, sessionFacts } from "../../src/services/session-view.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

/** A session's registry file; `pid` is this test process's when it is to count as live. */
function registry(pid: number, id: string, name: string): SessionEnv {
  const dir = join(claudeHome(), "sessions");
  mkdirSync(dir, { recursive: true });
  const socketPath = `/tmp/cc-socks/${pid}-${id}.sock`;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, name, messagingSocketPath: socketPath }),
  );
  return { sessionId: id, hostSessionId: null, socketPath, token: null };
}

function run(repo: string, title: string, startedBy: string | null, minutesAgo: number): Run {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const r = createRun({
    repo,
    title,
    aLines: ["A1"],
    version: "0",
    now: at,
    startedBy: startedBy
      ? { sessionId: startedBy, hostSessionId: null, name: `${startedBy} at start` }
      : null,
  });
  // its files as old as the run: activity is what the test says it is
  for (const f of [runPaths(r.dir).ledger, runPaths(r.dir).runs, runPaths(r.dir).meta]) utimesSync(f, at, at);
  return r;
}

describe("runs grouped by session (spec §4)", () => {
  it("groups by the starting session, lists a continued run under both, and puts 1.0 runs last", async () => {
    withHome();
    const repo = tempRepo();
    const auth = run(repo, "Auth MR A", "s-a", 30);
    const kit = run(repo, "Kit clean-up", "s-a", 20);
    const old = run(repo, "Before 1.1", null, 1);
    // s-b continues the kit run: it is s-b's now, and s-a's list says where it went
    await claimRun(fakeDeps({ session: registry(4_000_001, "s-b", "desktop two") }), kit);
    const groups = groupRuns([auth, kit, old]);
    expect(
      groups.map((g) => ({
        session: g.session?.name ?? "earlier runs",
        runs: g.runs.map(
          (x) =>
            `${x.run.meta.title}${x.continued ? ` (${x.continued}${x.continuedIn ? `: ${x.continuedIn}` : ""})` : ""}`,
        ),
      })),
    ).toEqual([
      { session: "desktop two", runs: ["Kit clean-up (here)"] },
      { session: "s-a at start", runs: ["Kit clean-up (elsewhere: desktop two)", "Auth MR A"] },
      { session: "earlier runs", runs: ["Before 1.1"] },
    ]);
  });

  it("names a running session from its file, so a rename shows, and a stopped one by the last name recorded", () => {
    withHome();
    const repo = tempRepo();
    const r = run(repo, "Auth", "s-live", 5);
    registry(process.pid, "s-live", "renamed in Desktop");
    expect(sessionFacts(r).session).toEqual({
      sessionId: "s-live",
      hostSessionId: null,
      name: "renamed in Desktop",
      live: true,
    });
    const stopped = run(repo, "Old", "s-gone", 5);
    registry(2_147_483_001, "s-gone", "not read: its process is gone");
    expect(sessionFacts(stopped).session).toMatchObject({ name: "s-gone at start", live: false });
  });

  it("orders sessions by their newest activity", () => {
    withHome();
    const repo = tempRepo();
    const a = run(repo, "a", "s-1", 50);
    const b = run(repo, "b", "s-2", 40);
    expect(groupRuns([a, b]).map((g) => g.session?.sessionId)).toEqual(["s-2", "s-1"]);
    // s-1's run is written to now: s-1 moves up
    writeFileSync(runPaths(a.dir).stateJson, "{}");
    expect(groupRuns([a, b]).map((g) => g.session?.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("says a run continued in another session, from the run's own facts", async () => {
    withHome();
    const repo = tempRepo();
    const r = run(repo, "moved", "s-a", 10);
    expect(sessionFacts(r).continuedIn).toBeNull();
    await claimRun(fakeDeps({ session: registry(4_000_002, "s-c", "third") }), r);
    expect(sessionFacts(r)).toMatchObject({ session: { sessionId: "s-a" }, continuedIn: "third" });
  });
});

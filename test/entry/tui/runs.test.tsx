import { afterEach, describe, expect, it } from "bun:test";
import { RUNS_EVERY_MS } from "../../../src/entry/tui/providers/data.tsx";
import { FIXTURE_SESSIONS, fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { RUN_EVERY_MS, RunsView, WATCHED_EVERY_MS } from "../../../src/entry/tui/views/runs.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { type Harness, harness } from "./harness.tsx";
import { Shell } from "./shell.tsx";

afterEach(snapshotEnv());
let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

async function runs(effects = fixtureEffects()) {
  withHome();
  h = await harness(
    <Shell width={100} height={19}>
      <RunsView width={100} height={19} />
    </Shell>,
    { effects, width: 100, height: 19 },
  );
  await h.advance(0);
  return effects;
}

describe("the Runs tab (spec §4)", () => {
  it("lists the sessions, newest activity first, with a state word, and when it last read them", async () => {
    await runs();
    const f = h!.s.frame();
    expect(f).toContain("SESSIONS  updated just now");
    expect(f).toContain("● live  jobs screen  1 run · 3 live roles · 1 landed  20s ago");
    expect(f).toContain("· idle  kit follow-up  1 run · 0 live roles · 3 landed  1d ago");
    expect(f.indexOf("jobs screen")).toBeLessThan(f.indexOf("kit follow-up"));
    expect(f.indexOf("kit follow-up")).toBeLessThan(f.indexOf("auth build"));
  });

  it("says a read failed, keeping when the sessions were last read", async () => {
    const fx = await runs();
    fx.sessions = () => {
      throw new Error("runs directory is not readable");
    };
    await h!.advance(5 * RUNS_EVERY_MS);
    const f = h!.s.frame();
    expect(f).toContain("could not read the runs: runs directory is not readable");
    expect(f).toContain("updated 10s ago");
    expect(f).toContain("jobs screen");
  });

  it("shows the mascot and how to start a run when there are none", async () => {
    await runs(fixtureEffects({ runs: [], sessions: [] }));
    expect(h!.s.frame()).toContain("(=-.-=)/");
    expect(h!.s.frame()).toContain("No runs yet. Start one in Claude Code: /catherd <what to build>");
  });

  it("opens a session: its runs, their milestones, and every role, live ones first, ticking; esc goes back", async () => {
    await runs();
    await h!.s.press("return");
    let f = h!.s.frame();
    expect(f).toContain("jobs screen  ● live · 1 run · 3 live roles");
    expect(f).toContain("▸ Jobs screen  /home/me/app · started 12m ago · budget 52%");
    expect(f).toContain("✓ M0 scaffold the jobs screen  ◌ M1");
    expect(f).toContain("● worker-M1.L2    gpt-6-sol#medium   running  04:12  $ bun test test/jobs --bail");
    expect(f).toContain("◌ reviewer-M1     gpt-6-sol#high     starting 00:04");
    expect(f).toContain("✓ worker-M1.L1    gpt-6-luna#high    ok       05:12");
    expect(f.indexOf("reviewer-M1")).toBeLessThan(f.indexOf("worker-M1.L1 "));
    // a live role's elapsed time ticks every second, with nothing read again
    await h!.advance(1_000);
    f = h!.s.frame();
    expect(f).toContain("running  04:13");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("SESSIONS");
  });

  it("marks a run continued in another session, and under that session as continued here", async () => {
    await runs();
    await h!.s.press("j", "j", "return");
    expect(h!.s.frame()).toContain(
      "▸ Auth refactor  /home/me/api · started 1d ago · continued in kit follow-up",
    );
    await h!.s.press("escape", "j", "return");
    expect(h!.s.frame()).toContain("▸ Auth refactor  /home/me/api · started 1d ago · continued here");
  });

  it("opens a role: its brief, reply and record; esc goes back to its session, then to the list", async () => {
    await runs();
    await h!.s.press("return", "j", "j", "j", "return");
    const f = h!.s.frame();
    expect(f).toContain("worker-M1.L1 worker · gpt-6-luna#high · ok · Jobs screen");
    expect(f).toContain("BRIEF");
    expect(f).toContain("Fast check: bun test test/jobs/list");
    expect(f).toContain("STATUS: complete — list in place, fast check green");
    expect(f).toContain("RECORD");
    expect(f).toContain("changed src/jobs/list.tsx, src/jobs/list.test.tsx");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("jobs screen  ● live");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("SESSIONS");
  });

  it("redraws the open session when a run file changes, and polls every second where it cannot watch", async () => {
    const fx = fixtureEffects();
    let reads = 0;
    const read = fx.session;
    fx.session = (key) => {
      reads++;
      return read(key);
    };
    await runs(fx);
    await h!.s.press("return");
    expect(fx.watched).toEqual([["/runs/20260926-114800-jobs-screen"]]);
    const before = reads;
    await h!.run(() => fx.touch());
    await h!.advance(0);
    expect(reads).toBe(before + 1);
    // watched: only the slow safety read, not one a second
    await h!.advance(RUN_EVERY_MS * 3);
    expect(reads).toBe(before + 1);
    await h!.advance(WATCHED_EVERY_MS);
    expect(reads).toBe(before + 2);
    await h!.s.press("escape");
    expect(fx.watched).toEqual([]);

    const blind = fixtureEffects({ watchable: false });
    let polls = 0;
    const r2 = blind.session;
    blind.session = (key) => {
      polls++;
      return r2(key);
    };
    await h!.s.close();
    await runs(blind);
    await h!.s.press("return");
    const p0 = polls;
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      await h!.advance(RUN_EVERY_MS);
      seen.push(polls - p0);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("pauses the updates with p, watch included, and says so", async () => {
    const fx = fixtureEffects();
    let reads = 0;
    const read = fx.session;
    fx.session = (key) => {
      reads++;
      return read(key);
    };
    await runs(fx);
    await h!.s.press("return", "p");
    expect(h!.s.frame()).toContain("paused");
    expect(fx.watched).toEqual([]);
    const paused = reads;
    await h!.run(() => fx.touch());
    await h!.advance(WATCHED_EVERY_MS * 3);
    expect(reads).toBe(paused);
  });

  it("cancels a live role only on a second ctrl+d within 5 s", async () => {
    const fx = await runs();
    await h!.s.press("return", "ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to cancel");
    await h!.advance(5_001);
    await h!.s.press("ctrl+d");
    expect(fx.writes).toEqual([]);
    await h!.s.press("ctrl+d");
    expect(fx.writes).toEqual(["cancel 20260926-114800-jobs-screen worker-M1.L2"]);
  });

  it("takes back a first ctrl+d when the cursor moves, and never cancels a finished role", async () => {
    const fx = await runs();
    await h!.s.press("return", "ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to cancel");
    await h!.s.press("j");
    expect(h!.s.frame()).not.toContain("press ctrl+d again to cancel");
    await h!.s.press("j", "j", "ctrl+d", "ctrl+d");
    expect(fx.writes).toEqual([]);
  });

  it("keeps a fixture of every shape the frames need", () => {
    expect(FIXTURE_SESSIONS.map((s) => s.row.key)).toEqual(["s-jobs", "s-kit", "s-auth"]);
  });
});

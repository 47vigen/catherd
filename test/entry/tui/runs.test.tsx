import { afterEach, describe, expect, it } from "bun:test";
import { RUNS_EVERY_MS } from "../../../src/entry/tui/providers/data.tsx";
import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { RUN_EVERY_MS, RunsView } from "../../../src/entry/tui/views/runs.tsx";
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
    <Shell width={80} height={19}>
      <RunsView width={80} height={19} />
    </Shell>,
    { effects, width: 80, height: 19 },
  );
  await h.advance(0);
  return effects;
}

describe("the Runs tab (spec §9.1)", () => {
  it("lists runs with a state word first, and when it last read them", async () => {
    await runs();
    const f = h!.s.frame();
    expect(f).toContain("● live  Jobs screen  /home/me/app  2 live · 3 role runs · 1 landed");
    expect(f).toContain("· idle  Auth refactor");
    expect(f).toContain("updated just now");
  });

  it("says a read failed, keeping when the rows were last read, instead of 'updated just now'", async () => {
    const fx = await runs();
    fx.runs = () => {
      throw new Error("runs directory is not readable");
    };
    await h!.advance(5 * RUNS_EVERY_MS);
    const f = h!.s.frame();
    expect(f).toContain("runs directory is not readable");
    expect(f).not.toContain("updated just now");
    expect(f).toContain("updated 10s ago");
    expect(f).toContain("Jobs screen");
  });

  it("opens a run: live lanes, climbs, routes, budget bar, landed milestones; esc goes back", async () => {
    await runs();
    await h!.s.press("return");
    const f = h!.s.frame();
    expect(f).toContain("[████████████████░░░░░░░░░░░░░░] 52% · 31/60 min");
    expect(f).toContain("● worker-M1.L2    gpt-6-sol#medium    04:12   running");
    expect(f).toContain("M1.L2    gpt-6-luna#high → gpt-6-sol#medium  refused");
    expect(f).toContain("M1.L1    worker    lane    repo_code/copy");
    expect(f).toContain("✓ M0 | scaffold the jobs screen");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("RUNS");
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

  it("takes back a first ctrl+d when the cursor moves", async () => {
    const fx = await runs();
    await h!.s.press("return", "ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to cancel");
    await h!.s.press("j");
    expect(h!.s.frame()).not.toContain("press ctrl+d again to cancel");
    await h!.s.press("k", "ctrl+d");
    expect(fx.writes).toEqual([]);
    expect(h!.s.frame()).toContain("press ctrl+d again to cancel");
  });

  it("pauses the updates with p and says so", async () => {
    const fx = fixtureEffects();
    let reads = 0;
    const read = fx.run;
    fx.run = (id) => {
      reads++;
      return read(id);
    };
    await runs(fx);
    await h!.s.press("return");
    const before = reads;
    await h!.advance(RUN_EVERY_MS);
    expect(reads).toBe(before + 1);
    await h!.s.press("p");
    expect(h!.s.frame()).toContain("paused");
    const paused = reads;
    await h!.advance(RUN_EVERY_MS * 5);
    expect(reads).toBe(paused);
  });

  it("shows the mascot and how to start a run when there are none", async () => {
    await runs(fixtureEffects({ runs: [] }));
    expect(h!.s.frame()).toContain("(=-.-=)/");
    expect(h!.s.frame()).toContain("No runs yet. Start one in Claude Code: /catherd <what to build>");
  });
});

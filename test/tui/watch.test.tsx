import { testRender } from "@opentui/react/test-utils";
import { type ReactNode } from "react";
import { describe, expect, it } from "bun:test";
import type { RunSummary } from "../../src/core/status.ts";
import { Watch, type WatchDeps } from "../../src/tui/watch.tsx";
import { fakeRecord } from "../records.ts";
import { fakeRun, fakeSummary, KEY, PLAIN, press, tick, UI, widest } from "./helpers.ts";

const live = { name: "worker-M1.L2", rung: "gpt-6-sol#medium", secs: 252, pid: 1 };

function deps(o: Partial<WatchDeps> = {}): Partial<WatchDeps> {
  return {
    listRuns: () => [fakeRun()],
    summarizeRun: () =>
      fakeSummary({ live: [live], milestones: ["M1 | jobs list | a1b2c3d | vitest 12/12"] }),
    readRunRecords: () => [fakeRecord("worker-M1.L1", { secs: 60 })],
    readJev: () => [{ questions: ["kind"], used: "kind=repo_code", source: "jev" }],
    ...o,
  };
}

async function mounted(el: ReactNode, width = 100, height = 24) {
  const setup = await testRender(el, { width, height });
  await setup.renderOnce();
  return setup;
}

describe("Watch", () => {
  it("says so when there are no runs yet", async () => {
    const { captureCharFrame, renderOnce } = await mounted(
      <Watch ui={UI} deps={deps({ listRuns: () => [] })} />,
    );
    await tick();
    await renderOnce();
    expect(captureCharFrame()).toContain("No runs yet. Start one with /catherd in Claude Code.");
  });

  it("lists each run on the left, and shows the highlighted run's lanes on the right", async () => {
    const { captureCharFrame, renderOnce } = await mounted(<Watch ui={UI} deps={deps()} />);
    await tick();
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("RUNS");
    expect(f).toContain("▶ =o.o="); // the run's mood face, selected
    expect(f).toContain("🐈 worker-M1.L2  sol#medium  04:12  =o.o=");
    expect(f).toContain("Jobs screen"); // the right pane's title, untruncated
    expect(f).toContain("/r/app");
  });

  it("tells a climb in one line when a role returns on a higher rung", async () => {
    let n = 0;
    const summarizeRun = (): RunSummary =>
      fakeSummary({ live: [{ ...live, rung: n++ === 0 ? "gpt-6-luna#high" : "gpt-6-sol#medium" }] });
    const { captureCharFrame, renderOnce } = await mounted(
      <Watch ui={UI} intervalMs={20} deps={deps({ summarizeRun })} />,
    );
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      await new Promise((r) => setTimeout(r, 15));
      await renderOnce();
      found = captureCharFrame().includes("Luna gave up, Sol takes over");
    }
    expect(found).toBe(true);
  });

  it("shows the selected run's Jev decisions", async () => {
    const { captureCharFrame, renderOnce } = await mounted(<Watch ui={UI} deps={deps()} />);
    await tick();
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("jev · 4 decisions · 1 fell back");
    expect(f).toContain("kind → kind=repo_code");
  });

  it("moves the selection with the arrow keys", async () => {
    const summarizeRun = (run: { id: string }) => fakeSummary({ title: run.id === "a" ? "Run A" : "Run B" });
    const { captureCharFrame, mockInput, renderOnce } = await mounted(
      <Watch
        ui={UI}
        deps={deps({ listRuns: () => [fakeRun("a", "Run A"), fakeRun("b", "Run B")], summarizeRun })}
      />,
    );
    await tick();
    await renderOnce();
    expect(captureCharFrame()).toContain("Run A");
    await press(mockInput, KEY.down);
    await renderOnce();
    expect(captureCharFrame()).toContain("Run B");
  });

  it("shows one line for a run it cannot read, and carries on with the rest", async () => {
    const summarizeRun = (run: { id: string }) => {
      if (run.id === "bad") throw new Error("Unexpected end of JSON input");
      return fakeSummary();
    };
    const { captureCharFrame, renderOnce } = await mounted(
      <Watch ui={UI} deps={deps({ listRuns: () => [fakeRun(), fakeRun("bad", "Broken")], summarizeRun })} />,
    );
    await tick();
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("=x.x=");
    expect(f).toContain("JSON input");
    expect(f).toContain("Jobs screen");
  });

  it("survives listRuns itself throwing", async () => {
    const listRuns = () => {
      throw new Error("EACCES: permission denied");
    };
    const { captureCharFrame, renderOnce } = await mounted(<Watch ui={UI} deps={deps({ listRuns })} />);
    await tick();
    await renderOnce();
    expect(captureCharFrame()).toContain("=x.x= EACCES: permission denied");
  });

  it("shows the budget bar beside its formatted spend, under 80%", async () => {
    const { captureCharFrame, renderOnce } = await mounted(
      <Watch
        ui={UI}
        deps={deps({
          summarizeRun: () => fakeSummary({ budget: { fraction: 0.52, minutes: { spent: 12, cap: 23 } } }),
        })}
      />,
    );
    await tick();
    await renderOnce();
    expect(captureCharFrame()).toContain("12/23 min (52%)");
  });

  it("says nothing about the budget when a run has none set", async () => {
    const { captureCharFrame, renderOnce } = await mounted(<Watch ui={UI} deps={deps()} />);
    await tick();
    await renderOnce();
    expect(captureCharFrame()).not.toContain("%)");
  });

  it("renders the budget bar as a plain ASCII gauge under --plain", async () => {
    const { captureCharFrame, renderOnce } = await mounted(
      <Watch
        ui={PLAIN}
        deps={deps({
          summarizeRun: () => fakeSummary({ budget: { fraction: 0.9, usd: { spent: 9, cap: 10 } } }),
        })}
      />,
    );
    await tick();
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("[#########-] 90%");
    expect(f).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("keeps plain glyphs and 80 columns with long names", async () => {
    const summarizeRun = () =>
      fakeSummary({ title: "t".repeat(120), live: [{ ...live, name: `worker-${"x".repeat(100)}` }] });
    const { captureCharFrame, renderOnce } = await mounted(
      <Watch ui={PLAIN} deps={deps({ summarizeRun })} />,
      80,
    );
    await tick();
    await renderOnce();
    const f = captureCharFrame();
    expect(widest(f)).toBeLessThanOrEqual(80);
    expect(f).toMatch(/^[\x20-\x7e\n]*$/);
  });
});

import { testRender } from "@opentui/react/test-utils";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Init, type InitDeps } from "../../src/tui/init.tsx";
import { withHome } from "../helpers.ts";
import { catalogFixture, KEY, NOT_READY, press, UI, widest } from "./helpers.ts";

const GOOD = "tsk-fake-good-0123456789";
const BAD = "tsk-fake-bad-9876543210";

function fakeDeps(o: Partial<InitDeps> = {}): InitDeps {
  return {
    jevKey: () => null,
    testJevKey: mock(async (k: string) => k === GOOD),
    saveJevKey: mock(),
    detectBackends: mock(async () => NOT_READY),
    loadCatalog: catalogFixture,
    harnessCosts: () => [],
    save: mock(),
    ...o,
  };
}

async function waitFor(check: () => boolean, ms = 500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Init", () => {
  beforeEach(() => withHome());

  it("lets a key skip the intro", async () => {
    const setup = await testRender(<Init ui={{ ...UI, reducedMotion: false }} deps={fakeDeps()} />, {
      width: 100,
      height: 24,
    });
    await setup.renderOnce();
    await press(setup.mockInput, "x");
    await setup.renderOnce();
    await waitFor(() => setup.captureCharFrame().includes("Paste your TypeSafe API key."));
    expect(setup.captureCharFrame()).toContain("Paste your TypeSafe API key.");
  });

  it("masks the key, and never shows it in any frame", async () => {
    const d = fakeDeps();
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 100, height: 24 });
    await setup.renderOnce();
    await press(setup.mockInput, GOOD);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("*".repeat(GOOD.length));
    await press(setup.mockInput, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("worker");
    });
    // captureCharFrame does not accumulate history; the key never appears once typed either.
    expect(setup.captureCharFrame()).not.toContain(GOOD);
  });

  it("refuses to go on with a key Jev does not accept, and does not save it", async () => {
    const d = fakeDeps();
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 100, height: 24 });
    await setup.renderOnce();
    await press(setup.mockInput, BAD, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("Jev did not accept that key.");
    });
    expect(setup.captureCharFrame()).toContain("key:");
    expect(d.saveJevKey).not.toHaveBeenCalled();
    expect(d.detectBackends).not.toHaveBeenCalled();
    expect(setup.captureCharFrame()).not.toContain(BAD);
  });

  it("saves a good key, shows each backend with its fix, then the matrix", async () => {
    const d = fakeDeps();
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 100, height: 24 });
    await setup.renderOnce();
    await press(setup.mockInput, GOOD, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("worker");
    });
    expect(d.saveJevKey).toHaveBeenCalledWith(GOOD);
    const f = setup.captureCharFrame();
    expect(f).toContain("not installed · fix: npm i -g @openai/codex");
    expect(f).toContain("opencode 2.0.15   not logged in · fix: opencode auth login");
    expect(f).toContain("enter accept");
  });

  it("shows why a good key could not be saved, and stays on the key prompt", async () => {
    const d = fakeDeps({
      saveJevKey: mock(() => {
        throw new Error("credentials.json is from a newer catherd");
      }),
    });
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 100, height: 24 });
    await setup.renderOnce();
    await press(setup.mockInput, GOOD, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("Could not save the key: credentials.json is from a newer");
    });
    expect(setup.captureCharFrame()).toContain("key:");
    expect(d.detectBackends).not.toHaveBeenCalled();
  });

  it("takes a pasted key", async () => {
    const d = fakeDeps();
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 100, height: 24 });
    await setup.renderOnce();
    await setup.mockInput.pasteBracketedText(`${GOOD}\n`);
    await press(setup.mockInput, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("worker");
    });
    expect(d.saveJevKey).toHaveBeenCalledWith(GOOD);
  });

  it("skips the prompt when the saved key still answers", async () => {
    const d = fakeDeps({ jevKey: () => GOOD });
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 100, height: 24 });
    await setup.renderOnce();
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("worker");
    });
    expect(d.testJevKey).toHaveBeenCalledWith(GOOD);
    expect(d.saveJevKey).not.toHaveBeenCalled();
  });

  it("accepts the default profile on Enter, saves it, and prints the plugin steps", async () => {
    const d = fakeDeps();
    const setup = await testRender(<Init ui={UI} deps={d} />, { width: 80, height: 24 });
    await setup.renderOnce();
    await press(setup.mockInput, GOOD, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("worker");
    });
    await press(setup.mockInput, KEY.enter);
    await waitFor(() => {
      setup.renderOnce();
      return setup.captureCharFrame().includes("Press any key to finish.");
    });
    // "done" is a resting screen the user reads before a key exits it, so the frame is still
    // there to check now — pressing a key here would tear down the renderer immediately.
    expect(d.save).toHaveBeenCalledWith(expect.objectContaining({ name: "default" }), expect.anything());
    const f = setup.captureCharFrame();
    expect(f).toContain("/plugin marketplace add 47vigen/catherd");
    expect(f).toContain("/plugin install catherd@catherd");
    expect(f).toContain("start a new Claude Code session");
    expect(widest(f)).toBeLessThanOrEqual(80);
  });
});

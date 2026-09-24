import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { defaultProfile, saveProfile, setActiveProfile } from "../../src/profile/profile.ts";
import { Editor } from "../../src/tui/editor.tsx";
import { withHome } from "../helpers.ts";
import { catalogFixture, down, KEY, press, READY, UI } from "./helpers.ts";

const save = mock();
const deps = { loadCatalog: catalogFixture, detectBackends: async () => READY, harnessCosts: () => [], save };

async function mounted() {
  const setup = await testRender(<Editor ui={UI} deps={deps} />, { width: 100, height: 24 });
  await setup.renderOnce();
  // detectBackends resolves asynchronously; give the effect a tick then re-render.
  for (let i = 0; i < 10 && !setup.captureCharFrame().includes("worker"); i++) {
    await new Promise((r) => setTimeout(r, 10));
    await setup.renderOnce();
  }
  return setup;
}

describe("Editor", () => {
  beforeEach(() => {
    withHome();
    process.env.CATHERD_CLAUDE_AGENTS_DIR = mkdtempSync(join(tmpdir(), "catherd-agents-"));
    save.mockClear();
  });

  it("opens the active profile and saves it through the one writer on Enter", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    expect(captureCharFrame()).toContain("profile default 1/1");
    await press(mockInput, KEY.enter);
    await renderOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "default" }), expect.anything());
    expect(captureCharFrame()).toContain("Saved default; it is active now.");
  });

  it("shows validation errors inline and saves nothing", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    // worker open: 7 gpt-6-sol, 8 gpt-6-luna; space on a ticked model clears it
    await press(mockInput, ...down(2), KEY.right, ...down(5), KEY.space, KEY.down, KEY.space, KEY.enter);
    await renderOnce();
    expect(save).not.toHaveBeenCalled();
    expect(captureCharFrame()).toContain("=x.x=");
  });

  it("switches between saved profiles with p", async () => {
    saveProfile(defaultProfile());
    saveProfile({ ...defaultProfile(), name: "fast", objective: "speed" });
    setActiveProfile("default");
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    expect(captureCharFrame()).toContain("profile default");
    await press(mockInput, "p");
    await renderOnce();
    expect(captureCharFrame()).toContain("profile fast");
    expect(captureCharFrame()).toContain("objective     speed");
  });

  it("makes a new profile from the default and saves it under its own name", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    await press(mockInput, "n");
    await renderOnce();
    expect(captureCharFrame()).toContain("Name for the new profile:");
    await press(mockInput, "fast", KEY.enter);
    await renderOnce();
    expect(captureCharFrame()).toContain("profile fast 2/2 (unsaved)");
    await press(mockInput, KEY.enter);
    await renderOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "fast" }), expect.anything());
  });

  it("refuses a bad profile name", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    await press(mockInput, "c", "Bad Name", KEY.enter);
    await renderOnce();
    expect(captureCharFrame()).toContain("Use lowercase letters, digits and dashes");
    expect(captureCharFrame()).toContain("profile default 1/1");
  });

  it("refuses to delete the active profile", async () => {
    saveProfile(defaultProfile());
    saveProfile({ ...defaultProfile(), name: "fast" });
    setActiveProfile("default");
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    await press(mockInput, "x");
    await renderOnce();
    expect(captureCharFrame()).toContain("Delete profile default?");
    await press(mockInput, "y");
    await renderOnce();
    expect(captureCharFrame()).toContain("is the active profile");
  });

  it("asks before quitting with unsaved changes", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted();
    await press(mockInput, ...down(8), KEY.space, "q");
    await renderOnce();
    expect(captureCharFrame()).toContain("Unsaved changes in default.");
  });
});

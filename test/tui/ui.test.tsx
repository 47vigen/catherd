import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it, mock } from "bun:test";
import { INTRO } from "../../src/tui/theme.ts";
import { CatSpinner, Header, Intro, Screen } from "../../src/tui/ui.tsx";
import { PLAIN, press, tick, UI, widest } from "./helpers.ts";

describe("Header", () => {
  it("puts the conductor cat beside the wordmark and the title", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <Header ui={UI} mood="good" title="profiles · default" />,
      {
        width: 80,
        height: 5,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toMatchSnapshot();
    expect(frame).toContain("(=^.^=)/");
    expect(frame).toContain("catherd");
    expect(frame).toContain("profiles · default");
  });

  it("still spells the wordmark through the true-colour gradient", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <Header ui={{ ...UI, depth: 24 }} mood="working" title="t" />,
      {
        width: 80,
        height: 5,
      },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("catherd");
    expect(frame).toContain("=o.o=");
  });

  it("falls back to ASCII under --plain", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<Header ui={PLAIN} mood="landed" title="t" />, {
      width: 80,
      height: 5,
    });
    await renderOnce();
    expect(captureCharFrame()).toContain("=^w^=");
  });
});

describe("CatSpinner", () => {
  it("names what it waits on, and stands still under reduced motion", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <CatSpinner ui={UI} label="asking Jev a test question" />,
      {
        width: 80,
        height: 2,
      },
    );
    await renderOnce();
    const first = captureCharFrame();
    expect(first).toContain("m=o.o=~ asking Jev a test question · herding…");
    await tick(400);
    await renderOnce();
    expect(captureCharFrame()).toBe(first);
  });

  it("animates otherwise", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <CatSpinner ui={{ ...UI, reducedMotion: false }} label="x" />,
      { width: 80, height: 2 },
    );
    await renderOnce();
    const first = captureCharFrame();
    await tick(400);
    await renderOnce();
    expect(captureCharFrame()).not.toBe(first);
  });
});

describe("Intro", () => {
  it("is skipped by any key", async () => {
    const onDone = mock();
    const { renderOnce, mockInput } = await testRender(
      <Intro ui={{ ...UI, reducedMotion: false }} onDone={onDone} />,
      {
        width: 80,
        height: 5,
      },
    );
    await renderOnce();
    await press(mockInput, "x");
    expect(onDone).toHaveBeenCalled();
  });

  it("ends by itself inside 1.5 s", async () => {
    const onDone = mock();
    const { renderOnce } = await testRender(<Intro ui={{ ...UI, reducedMotion: false }} onDone={onDone} />, {
      width: 80,
      height: 5,
    });
    await renderOnce();
    await tick(INTRO.steps * INTRO.ms + 200);
    await renderOnce();
    expect(onDone).toHaveBeenCalled();
  });

  it("does not play under reduced motion", async () => {
    const onDone = mock();
    const { renderOnce } = await testRender(<Intro ui={UI} onDone={onDone} />, { width: 80, height: 5 });
    await renderOnce();
    await tick();
    expect(onDone).toHaveBeenCalled();
  });
});

describe("Screen", () => {
  it("cuts every line at 80 columns", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <Screen>
        <Header ui={UI} mood="good" title={"x".repeat(200)} />
      </Screen>,
      { width: 120, height: 5 },
    );
    await renderOnce();
    expect(widest(captureCharFrame())).toBeLessThanOrEqual(80);
  });
});

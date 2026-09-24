import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it, mock } from "bun:test";
import { INTRO } from "../../src/tui/theme.ts";
import { CatSpinner, DetailPane, Frame, Intro, ListLine } from "../../src/tui/ui.tsx";
import { PLAIN, press, tick, UI, widest } from "./helpers.ts";

describe("Wordmark (via Intro)", () => {
  it("plays the wordmark reveal and shows the herding copy beneath it", async () => {
    const onDone = mock();
    const { renderOnce, captureCharFrame } = await testRender(
      <Intro ui={{ ...UI, reducedMotion: false }} onDone={onDone} />,
      { width: 80, height: 5 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("(=-.-=)/");
    expect(frame).toContain("herding");
  });

  it("falls back to ASCII under --plain", async () => {
    const { renderOnce, captureCharFrame } = await testRender(<Intro ui={PLAIN} onDone={mock()} />, {
      width: 80,
      height: 5,
    });
    await renderOnce();
    expect(captureCharFrame()).toMatch(/^[\x20-\x7e\n]*$/);
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

describe("Frame", () => {
  it("sets the title into the panel border, and draws the hint below it", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <Frame ui={UI} title="catherd" hint="↑↓ navigate   q quit">
        <text>hello</text>
      </Frame>,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("catherd");
    expect(frame).toContain("hello");
    expect(frame).toContain("↑↓ navigate   q quit");
  });

  it("draws an ASCII border under --plain", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <Frame ui={PLAIN} title="catherd" hint="q quit">
        <text>hello</text>
      </Frame>,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toMatch(/^[\x20-\x7e\n]*$/);
    expect(frame).toContain("+");
  });

  it("fills 80 columns exactly, and widens past it on a bigger terminal", async () => {
    const at80 = await testRender(
      <Frame ui={UI} title="t" hint="h">
        <text>x</text>
      </Frame>,
      { width: 80, height: 10 },
    );
    await at80.renderOnce();
    expect(widest(at80.captureCharFrame())).toBe(80);

    const at120 = await testRender(
      <Frame ui={UI} title="t" hint="h">
        <text>x</text>
      </Frame>,
      { width: 120, height: 10 },
    );
    await at120.renderOnce();
    expect(widest(at120.captureCharFrame())).toBe(120);
  });
});

describe("DetailPane and ListLine", () => {
  it("shows an accent title, a dim subtitle, and a selected row with its marker", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <DetailPane ui={UI} title="SELECTED ACTION" subtitle="one line">
        <ListLine ui={UI} selected text="Profile" />
        <ListLine ui={UI} selected={false} text="Watch runs" />
      </DetailPane>,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("SELECTED ACTION");
    expect(frame).toContain("one line");
    expect(frame).toContain("▶ Profile");
    expect(frame).toContain("Watch runs");
  });

  it("uses > for the selected marker under --plain", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ListLine ui={PLAIN} selected text="Profile" />,
      { width: 80, height: 2 },
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("> Profile");
  });
});

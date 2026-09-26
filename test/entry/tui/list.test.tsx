import { afterEach, describe, expect, it } from "bun:test";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../../../src/entry/tui/providers/app.tsx";
import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
import { Line } from "../../../src/entry/tui/widgets/line.tsx";
import { List, type ListItem, step, windowOf } from "../../../src/entry/tui/widgets/list.tsx";
import { type Harness, harness } from "./harness.tsx";

let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

describe("windowOf", () => {
  it("shows everything when it fits", () => {
    expect(windowOf(5, 4, 10, 0)).toEqual({ top: 0, above: 0, below: 0 });
  });

  it("moves no more than needed, keeping the selected row off the hint lines", () => {
    expect(windowOf(30, 0, 10, 0)).toEqual({ top: 0, above: 0, below: 20 });
    expect(windowOf(30, 8, 10, 0)).toEqual({ top: 0, above: 0, below: 20 });
    expect(windowOf(30, 9, 10, 0)).toEqual({ top: 1, above: 1, below: 19 });
    expect(windowOf(30, 29, 10, 0)).toEqual({ top: 20, above: 20, below: 0 });
    expect(windowOf(30, 21, 10, 20)).toEqual({ top: 20, above: 20, below: 0 });
    expect(windowOf(30, 20, 10, 20)).toEqual({ top: 19, above: 19, below: 1 });
  });

  it("drops the hints when the pane is too short for them", () => {
    expect(windowOf(30, 5, 2, 0)).toEqual({ top: 4, above: 0, below: 0 });
  });
});

describe("step", () => {
  const rows = [false, true, true, false, true].map((selectable) => ({ selectable }));
  it("moves between selectable rows only, and stops at the ends", () => {
    expect([step(rows, 1, 1), step(rows, 2, 1), step(rows, 4, 1), step(rows, 1, -1)]).toEqual([2, 4, 4, 1]);
    expect([step(rows, 0, 0), step(rows, 3, 1), step(rows, 3, -1), step(rows, 1, 99)]).toEqual([1, 4, 2, 4]);
    expect(step([{ selectable: false }], 0, 1)).toBe(-1);
  });
});

function Fixture(props: { n: number; height: number }) {
  const app = useApp();
  // the App's esc: run the newest back handler
  useCommandLayer("global", { "app.back": () => void app.back() });
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const all: ListItem[] = Array.from({ length: props.n }, (_, i) => ({
    key: `row${i}`,
    selectable: i % 5 !== 0,
    render: (sel, w) => (
      <Line
        width={w}
        selected={sel}
        parts={[{ text: `${sel ? ">" : " "} ${i % 5 === 0 ? "HEAD" : "row"} ${i}` }]}
      />
    ),
  }));
  const items = filter ? all.filter((it) => it.key.includes(filter)) : all;
  return (
    <box flexDirection="column">
      <text>{`selected=${selected} filter=${filter}`}</text>
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={40}
        height={props.height}
        filter={filter}
        onFilter={setFilter}
        empty="nothing"
      />
    </box>
  );
}

/**
 * Rows that arrive late (read on a timer, as the Profiles tree's catalog is), and a key that lands
 * right after they are drawn, before React has run the effects of that draw: the timing of a key sent
 * as soon as the screen shows the rows, on a busy machine. The layout effect sends it at exactly that
 * point.
 */
function LateRows(props: { press: () => void }) {
  const app = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const sent = useRef(false);
  useEffect(() => {
    const t = app.clock.setTimeout(() => setN(4), 100);
    return () => app.clock.clearTimeout(t);
  }, [app.clock]);
  useLayoutEffect(() => {
    if (n > 0 && !sent.current) {
      sent.current = true;
      props.press();
    }
  });
  const items: ListItem[] = Array.from({ length: n }, (_, i) => ({
    key: `row${i}`,
    selectable: true,
    render: (sel, w) => <Line width={w} selected={sel} parts={[{ text: `row ${i}` }]} />,
  }));
  return (
    <box flexDirection="column">
      <text>{`selected=${selected}`}</text>
      <List items={items} selected={selected} onSelect={setSelected} width={40} height={6} empty="…" />
    </box>
  );
}

describe("List (spec §9.2 lists)", () => {
  it("keeps a move made before the effects of the first draw of its rows ran", async () => {
    h = await harness(<LateRows press={() => h?.s.mockInput.pressKey("j")} />, { width: 40, height: 8 });
    await h.advance(100);
    expect(h.s.frame()).toContain("selected=row1");
  });

  it("moves with arrows and j/k, pages, and goes to the ends, skipping headings", async () => {
    h = await harness(<Fixture n={30} height={8} />, { width: 40, height: 10 });
    expect(h.s.frame()).toContain("selected=row1");
    await h.s.press("j", "down", "k");
    expect(h.s.frame()).toContain("selected=row2");
    await h.s.press("shift+g");
    expect(h.s.frame()).toContain("selected=row29");
    await h.s.press("g");
    expect(h.s.frame()).toContain("selected=row1");
    await h.s.press("pagedown");
    expect(h.s.frame()).toContain("selected=row8");
    await h.s.press("end", "home");
    expect(h.s.frame()).toContain("selected=row1");
  });

  it("says how many rows are hidden above and below instead of a scrollbar", async () => {
    h = await harness(<Fixture n={30} height={8} />, { width: 40, height: 10 });
    expect(h.s.frame()).toContain("↓ 23 more");
    await h.s.press("shift+g");
    expect(h.s.frame()).toContain("↑ 23 more");
    expect(h.s.frame()).not.toContain("↓");
  });

  it("filters with /: letters type, enter keeps the filter, esc clears it", async () => {
    h = await harness(<Fixture n={30} height={8} />, { width: 40, height: 10 });
    await h.s.press("/");
    await h.s.type("w2");
    expect(h.s.frame()).toContain("filter=w2");
    // row2 and row21–29 match; row20 and row25 are headings
    expect(h.s.frame()).toContain("9 matches");
    expect(h.s.frame()).toContain("> row 2 ");
    await h.s.press("return", "j");
    expect(h.s.frame()).toContain("selected=row21");
    expect(h.s.frame()).toContain("filter=w2");
    await h.s.press("/", "escape");
    expect(h.s.frame()).toContain("filter=null");
  });

  it("shows one muted line when empty", async () => {
    h = await harness(<Fixture n={0} height={5} />, { width: 40, height: 7 });
    expect(h.s.frame()).toContain("nothing");
  });
});

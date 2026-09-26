import type { InputRenderable } from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useBack } from "../providers/app.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useTone, useUi } from "../providers/theme.tsx";
import { glyph } from "../theme.ts";
import { Line } from "./line.tsx";

export interface ListItem {
  key: string;
  /** headings and continuation lines are skipped by the cursor */
  selectable: boolean;
  render(selected: boolean, width: number): ReactNode;
}

export interface Window {
  top: number;
  /** rows hidden above and below the window */
  above: number;
  below: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Which rows of `total` fit in `height` so that `index` shows, moving no more than needed from `top`.
 * With 3 rows or more, a hint line (`↑ 3 more`) takes the first or the last row when rows are hidden there.
 */
export function windowOf(total: number, index: number, height: number, top: number): Window {
  if (total <= height) return { top: 0, above: 0, below: 0 };
  const i = clamp(index, 0, total - 1);
  const maxTop = total - height;
  let t = clamp(top, 0, maxTop);
  if (height >= 3) {
    const first = t + (t > 0 ? 1 : 0);
    const last = t + height - 1 - (t < maxTop ? 1 : 0);
    if (i < first) t = i === 0 ? 0 : i - 1;
    else if (i > last) t = i === total - 1 ? maxTop : i - height + 2;
  } else if (i < t) t = i;
  else if (i > t + height - 1) t = i - height + 1;
  t = clamp(t, 0, maxTop);
  return height >= 3 ? { top: t, above: t, below: maxTop - t } : { top: t, above: 0, below: 0 };
}

/**
 * The selectable row `by` selectable rows away from row `from` (clamped to the ends). From a row that
 * cannot be selected, the next selectable row is one step down and the previous one a step up; `by` 0
 * snaps to the next one (else the last).
 */
export function step(items: readonly { selectable: boolean }[], from: number, by: number): number {
  const sel = items.flatMap((it, i) => (it.selectable ? [i] : []));
  if (sel.length === 0) return -1;
  const at = sel.indexOf(from);
  if (at >= 0) return sel[clamp(at + by, 0, sel.length - 1)] as number;
  const next = sel.findIndex((i) => i > from);
  if (by === 0) return sel[next < 0 ? sel.length - 1 : next] as number;
  const pos = by > 0 ? (next < 0 ? sel.length - 1 : next + by - 1) : (next < 0 ? sel.length : next) + by;
  return sel[clamp(pos, 0, sel.length - 1)] as number;
}

/**
 * A view's selected row: `selected` is what this render draws, `current()` what a key handler must read
 * (a key in the same tick may have moved it already).
 */
export function useSelected(): {
  selected: string | null;
  select(key: string): void;
  current(): string | null;
} {
  const [selected, setSelected] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  ref.current = selected;
  return {
    selected,
    select(key) {
      ref.current = key;
      setSelected(key);
    },
    current: () => ref.current,
  };
}

/**
 * A list or tree pane (spec §9.2 lists: arrows plus j/k, paging, Home/End, `/` filter). Controlled: the
 * view owns the selected key and the filter text; the list moves them and draws the visible window with
 * `↑ n more` / `↓ n more` hints instead of a scrollbar.
 */
export function List(props: {
  items: ListItem[];
  selected: string | null;
  onSelect(key: string): void;
  width: number;
  height: number;
  /** the filter text, null when no filter is open */
  filter?: string | null;
  onFilter?(text: string | null): void;
  /** the muted line shown when there are no rows */
  empty: string;
}) {
  const ui = useUi();
  const tone = useTone();
  const input = useRef<InputRenderable>(null);
  const [top, setTop] = useState(0);
  // the command that opens the filter is drawn at once (useCommandLayer), so this runs before the next key
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focusTick > 0) input.current?.focus();
  }, [focusTick]);
  const filtering = props.filter !== undefined && props.filter !== null;
  const bodyHeight = Math.max(1, props.height - (filtering ? 1 : 0));
  const indexOf = (key: string | null) => {
    const i = props.items.findIndex((it) => it.key === key);
    return i < 0 || !props.items[i]?.selectable ? step(props.items, Math.max(0, i), 0) : i;
  };
  const index = indexOf(props.selected);
  // the row a key handler moves from: the one the last key chose, which may not be drawn yet
  const selectedRef = useRef(props.selected);
  selectedRef.current = props.selected;
  const choose = (i: number) => {
    const it = props.items[i];
    if (!it) return;
    selectedRef.current = it.key;
    props.onSelect(it.key);
  };
  const w = windowOf(props.items.length, Math.max(0, index), bodyHeight, top);
  useEffect(() => {
    if (w.top !== top) setTop(w.top);
  }, [w.top, top]);
  useEffect(() => {
    const it = props.items[index];
    if (it && it.key !== props.selected) props.onSelect(it.key);
  });
  const move = (by: number) => choose(step(props.items, Math.max(0, indexOf(selectedRef.current)), by));
  const page = Math.max(1, bodyHeight - 2);
  useCommandLayer("list", {
    "list.up": () => move(-1),
    "list.down": () => move(1),
    "list.pageUp": () => move(-page),
    "list.pageDown": () => move(page),
    "list.first": () => choose(step(props.items, 0, 0)),
    "list.last": () => choose(step(props.items, props.items.length - 1, 0)),
    ...(props.onFilter
      ? {
          "list.filter": () => {
            props.onFilter?.(props.filter ?? "");
            setFocusTick((n) => n + 1);
          },
        }
      : {}),
  });
  useCommandLayer("filter", { "filter.accept": () => input.current?.blur() });
  useBack(filtering, "input", () => {
    input.current?.blur();
    props.onFilter?.(null);
  });
  const rows: ReactNode[] = [];
  const visible = props.items.slice(w.top, w.top + bodyHeight);
  visible.forEach((it, i) => {
    const hintAbove = i === 0 && w.above > 0;
    const hintBelow = i === visible.length - 1 && w.below > 0;
    if (hintAbove || hintBelow) {
      const n = hintAbove ? w.above + 1 : w.below + 1;
      rows.push(
        <Line
          key={`hint-${hintAbove ? "up" : "down"}`}
          width={props.width}
          parts={[{ text: `  ${glyph(hintAbove ? "up" : "down", ui.plain)} ${n} more`, tone: "muted" }]}
        />,
      );
      return;
    }
    rows.push(<box key={it.key}>{it.render(w.top + i === index, props.width)}</box>);
  });
  if (props.items.length === 0)
    rows.push(<Line key="empty" width={props.width} parts={[{ text: `  ${props.empty}`, tone: "muted" }]} />);
  const matches = props.items.filter((it) => it.selectable).length;
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      {filtering ? (
        <box flexDirection="row" width={props.width} height={1}>
          <text fg={tone("accent")}>{" / "}</text>
          <input
            ref={input}
            value={props.filter ?? ""}
            onInput={(v: string) => props.onFilter?.(v)}
            width={Math.max(1, props.width - 18)}
          />
          <text fg={tone("muted")}>{` ${matches} ${matches === 1 ? "match" : "matches"}`.padEnd(15)}</text>
        </box>
      ) : null}
      {rows}
    </box>
  );
}

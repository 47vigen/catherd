// Adapted from anomalyco/opencode packages/tui/src/ui/dialog-select.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import type { InputRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useApp } from "../providers/app.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useTone, useUi } from "../providers/theme.tsx";
import { type Dialog as DialogState, isArmed, type SelectOption } from "../state.ts";
import { glyph } from "../theme.ts";
import { Dialog, dialogRows } from "./dialog.tsx";
import { Line, type Part } from "./line.tsx";
import { windowOf } from "./list.tsx";

type Select = Extract<DialogState, { kind: "select" }>;

interface Entry {
  key: string;
  heading: string | null;
  option: SelectOption | null;
}

/** Options matching every word of `text` in their title, group or detail. */
export function matchOptions(options: SelectOption[], text: string): SelectOption[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((o) => {
    const hay = `${o.title} ${o.group ?? ""} ${o.detail ?? ""} ${o.cli ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Grouped lines for the options: a heading before each group, Suggested first while not filtering. */
export function entriesOf(d: Select, text: string): Entry[] {
  const shown = matchOptions(d.options, text);
  const out: Entry[] = [];
  if (!text.trim() && d.suggested?.length) {
    out.push({ key: "h:Suggested", heading: "Suggested", option: null });
    for (const v of d.suggested) {
      const o = d.options.find((x) => x.value === v);
      if (o) out.push({ key: `s:${v}`, heading: null, option: o });
    }
  }
  let group: string | undefined;
  for (const o of shown) {
    if (o.group !== undefined && o.group !== group)
      out.push({ key: `h:${o.group}`, heading: o.group, option: null });
    group = o.group;
    out.push({ key: `o:${o.value}`, heading: null, option: o });
  }
  return out;
}

/**
 * The picker every list dialog uses (palette, help, profile list, treat-like, failover, default rung):
 * a filter that owns the letters, ↑/↓ or ctrl+p/ctrl+n to move, enter to choose, esc to cancel; ctrl+d
 * twice deletes where the dialog offers it (spec §9.2).
 */
export function DialogSelect(props: { dialog: Select }) {
  const app = useApp();
  const ui = useUi();
  const tone = useTone();
  const dims = useTerminalDimensions();
  const input = useRef<InputRenderable>(null);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  // what a key handler reads: the filter and cursor as they are now, not as drawn (keys in one tick)
  const textRef = useRef("");
  const indexRef = useRef(0);
  const [top, setTop] = useState(0);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const pick = (t: string, i: number) => {
    const entries = entriesOf(props.dialog, t);
    const selectable = entries.flatMap((e, n) => (e.option ? [n] : []));
    const cur = selectable[Math.max(0, Math.min(i, selectable.length - 1))];
    return { entries, selectable, cur, chosen: cur === undefined ? null : (entries[cur]?.option ?? null) };
  };
  const { entries, cur, chosen } = pick(text, index);
  const chosenNow = () => pick(textRef.current, indexRef.current).chosen;
  // every row the panel has above the rule and footer, less the filter and the gap under it
  const height = Math.max(3, Math.min(entries.length, dialogRows(dims.height) - 4));
  const w = windowOf(entries.length, cur ?? 0, height, top);
  useEffect(() => {
    if (w.top !== top) setTop(w.top);
  }, [w.top, top]);
  // moving the cursor takes back a first ctrl+d (opencode's session list does the same)
  const move = (by: number) => {
    if (app.getState().armed) app.dispatch({ type: "disarm" });
    const n = pick(textRef.current, indexRef.current).selectable.length;
    indexRef.current = Math.max(0, Math.min(n - 1, indexRef.current + by));
    setIndex(indexRef.current);
  };
  const armed = chosen ? isArmed(app.state, "delete", chosen.value, app.clock.now()) : false;
  useCommandLayer("dialog", {
    "dialog.up": () => move(-1),
    "dialog.down": () => move(1),
    "dialog.pageUp": () => move(-height),
    "dialog.pageDown": () => move(height),
    "dialog.submit": () => {
      const c = chosenNow();
      if (c) app.answer(c.value);
    },
    ...(props.dialog.deletable
      ? {
          "dialog.delete": () => {
            const c = chosenNow();
            if (!c) return;
            if (isArmed(app.getState(), "delete", c.value, app.clock.now())) {
              app.dispatch({ type: "disarm" });
              app.answer(`delete:${c.value}`);
            } else app.dispatch({ type: "arm", what: "delete", target: c.value, at: app.clock.now() });
          },
        }
      : {}),
  });
  const rows = (inner: number): ReactNode[] => {
    // columns: the title, the detail and the CLI twin, each padded to the widest in the whole list, so
    // they line up as the list scrolls; the CLI column goes when it does not fit, the detail column
    // falls back to the right edge when even it does not
    const wide = (f: (o: SelectOption) => string | undefined) =>
      Math.max(0, ...props.dialog.options.map((o) => Bun.stringWidth(f(o) ?? "")));
    const tw = wide((o) => o.title);
    const dw = wide((o) => o.detail);
    const cw = wide((o) => o.cli);
    const columns = 2 + tw + 2 + dw <= inner;
    const withCli = columns && cw > 0 && 2 + tw + 2 + dw + 2 + cw <= inner;
    const out: ReactNode[] = [
      <box key="filter" flexDirection="row" width={inner} height={1}>
        <text fg={tone("accent")}>{"> "}</text>
        <input
          ref={input}
          value={text}
          placeholder="type to filter"
          onInput={(v: string) => {
            textRef.current = v;
            indexRef.current = 0;
            setText(v);
            setIndex(0);
            if (app.getState().armed) app.dispatch({ type: "disarm" });
          }}
          width={inner - 2}
        />
      </box>,
      <Line key="gap" width={inner} parts={[]} />,
    ];
    if (entries.length === 0) {
      out.push(
        <Line
          key="none"
          width={inner}
          parts={[{ text: props.dialog.options.length ? "No match" : props.dialog.empty, tone: "muted" }]}
        />,
      );
      return out;
    }
    entries.slice(w.top, w.top + height).forEach((e, i) => {
      const at = w.top + i;
      if (i === 0 && w.above > 0)
        return out.push(
          <Line
            key="up"
            width={inner}
            parts={[{ text: `${glyph("up", ui.plain)} ${w.above + 1} more`, tone: "muted" }]}
          />,
        );
      if (i === height - 1 && w.below > 0)
        return out.push(
          <Line
            key="down"
            width={inner}
            parts={[{ text: `${glyph("down", ui.plain)} ${w.below + 1} more`, tone: "muted" }]}
          />,
        );
      if (!e.option)
        return out.push(
          <Line key={e.key} width={inner} parts={[{ text: e.heading ?? "", tone: "accent", bold: true }]} />,
        );
      const o = e.option;
      const selected = at === cur;
      const label = selected && armed ? "press ctrl+d again to delete" : o.title;
      const detail = o.detail ?? "";
      const left: Part[] = [
        { text: `${o.current ? glyph("current", ui.plain) : " "} ` },
        { text: label, tone: selected && armed ? "warning" : undefined },
      ];
      const pad = (t: string, n: number) => " ".repeat(Math.max(0, n - Bun.stringWidth(t)));
      const right: Part[] = columns
        ? [
            { text: `${pad(label, tw)}  ` },
            { text: withCli ? `${detail}${pad(detail, dw)}  ` : detail, tone: "muted" },
            { text: withCli ? (o.cli ?? "") : "", tone: "muted" },
          ]
        : [
            {
              text: " ".repeat(Math.max(1, inner - Bun.stringWidth(`  ${label}`) - Bun.stringWidth(detail))),
            },
            { text: detail, tone: "muted" },
          ];
      out.push(<Line key={e.key} width={inner} selected={selected} parts={[...left, ...right]} />);
    });
    return out;
  };
  return (
    <Dialog
      title={props.dialog.title}
      // the palette's CLI column needs the wide panel
      size={props.dialog.options.length > 40 || props.dialog.options.some((o) => o.cli) ? "large" : "medium"}
      rows={rows}
    />
  );
}

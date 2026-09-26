import { TextAttributes } from "@opentui/core";
import { usePendingSequence } from "@opentui/keymap/react";
import { type CommandId, formatKeys, LEADER } from "../commands.ts";
import { reachableCommands, useKeybinds, useKeymap, useKeymapVersion } from "../providers/keymap.tsx";
import { useTone, useUi } from "../providers/theme.tsx";
import { FACES, type Mood } from "../theme.ts";
import { TABS, type Tab } from "../state.ts";
import { width as widthOf } from "../text.ts";
import { Line, type Part } from "./line.tsx";

const TAB_TITLE: Record<Tab, string> = { status: "Status", profiles: "Profiles", runs: "Runs" };

/** Spec §9.3 header: one line with the version, the profile, the unsaved count and the mood face. */
export function Header(props: {
  version: string;
  profile: string | null;
  active: boolean;
  /** the word after the profile: "active", or "this repo" in a bound repo */
  label?: string;
  dirty: number;
  mood: Mood;
  width: number;
}) {
  const pending = usePendingSequence();
  const left: Part[] = [{ text: ` catherd ${props.version}`, bold: true }];
  if (props.profile) {
    left.push({ text: `  profile ${props.profile}` });
    if (props.active) left.push({ text: ` (${props.label ?? "active"})`, tone: "muted" });
  }
  if (props.dirty > 0) left.push({ text: ` · ${props.dirty} unsaved`, tone: "warning" });
  const right: Part[] = [];
  if (pending.length)
    right.push({
      text: `${pending.map((p) => (p.tokenName === "leader" ? LEADER : p.display)).join(" ")} …  `,
      tone: "accent",
    });
  right.push({ text: `${FACES[props.mood]} `, tone: props.mood === "failed" ? "error" : "muted" });
  const used = [...left, ...right].reduce((n, p) => n + widthOf(p.text), 0);
  const gap = Math.max(1, props.width - used);
  return <Line width={props.width} parts={[...left, { text: " ".repeat(gap) }, ...right]} />;
}

/** The tab strip: ` 1 Status   2 Profiles   3 Runs`, the active one bold in the accent. */
export function Tabs(props: { tab: Tab; width: number }) {
  const ui = useUi();
  const tone = useTone();
  return (
    <box flexDirection="row" width={props.width} height={1}>
      {TABS.map((t, i) => {
        const on = t === props.tab;
        const text = ` ${i + 1} ${TAB_TITLE[t]} `;
        return (
          <text
            key={t}
            wrapMode="none"
            fg={on ? tone(ui.color ? "accent" : "text") : tone("muted")}
            attributes={on ? TextAttributes.BOLD | (ui.color ? 0 : TextAttributes.INVERSE) : 0}
          >
            {i === 0 ? text : ` ${text}`}
          </text>
        );
      })}
    </box>
  );
}

/**
 * Spec §9.2: footer hints are generated from the commands a key would reach now, in their `hint` order,
 * as `key label` (the key as the user bound it). Hints drop from the end to fit, but the palette and
 * help hints stay.
 */
export function Footer(props: { width: number }) {
  useKeymapVersion();
  const keymap = useKeymap();
  const keys = useKeybinds();
  const ui = useUi();
  const hints = reachableCommands(keymap)
    .filter((c) => c.hint !== null && keys[c.id].length > 0)
    .sort((a, b) => (a.hint as number) - (b.hint as number))
    .map((c) => ({
      id: c.id,
      text: `${formatKeys(keys[c.id as CommandId].slice(0, 1), ui.plain)} ${c.short ?? c.title}`,
    }));
  const fixed = hints.filter((h) => h.id === "app.palette" || h.id === "app.help");
  const rest = hints.filter((h) => !fixed.includes(h));
  const sep = "  ";
  const room = props.width - 1 - fixed.reduce((n, h) => n + widthOf(h.text) + sep.length, 0);
  const kept: string[] = [];
  let used = 0;
  for (const h of rest) {
    if (used + widthOf(h.text) + sep.length > room) break;
    kept.push(h.text);
    used += widthOf(h.text) + sep.length;
  }
  const all = [...kept, ...fixed.map((h) => h.text)];
  const parts: Part[] = [{ text: " " }];
  all.forEach((t, i) => {
    const at = t.indexOf(" ");
    parts.push({ text: t.slice(0, at), bold: true }, { text: t.slice(at), tone: "muted" });
    if (i < all.length - 1) parts.push({ text: sep });
  });
  return <Line width={props.width} parts={parts} />;
}

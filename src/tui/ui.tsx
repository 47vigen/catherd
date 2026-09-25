import type { BorderCharacters } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { VERSION } from "../version.ts";
import {
  ACCENT,
  GRADIENT,
  glyph,
  herdLine,
  INTRO,
  type Mood,
  mascot,
  SPINNER,
  tint,
  type Ui,
} from "./theme.ts";

/** --plain's border: no box-drawing characters, just `+ - |` (spec: "ASCII borders"). */
const ASCII_BORDER: BorderCharacters = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  topT: "+",
  bottomT: "+",
  leftT: "+",
  rightT: "+",
  cross: "+",
};

/** Every screen's chrome: a bordered panel with its title set into the top border, and a short
 * key-hint line outside and below it (so the hint never competes with the border for space). */
/** The widest the layout grows; wider terminals centre it with margins on both sides. */
const MAX_WIDTH = 110;

export function Frame({
  ui,
  title,
  hint,
  mood = "good",
  above,
  children,
}: {
  ui: Ui;
  title: string;
  hint: string;
  mood?: Mood;
  above?: ReactNode;
  children: ReactNode;
}) {
  const { width } = useTerminalDimensions();
  const term = Math.max(width || 80, 80);
  const w = Math.min(term - 4, MAX_WIDTH);
  const accent = tint(ACCENT, ui.depth);
  return (
    <box style={{ flexDirection: "column", width: term, alignItems: "center", paddingTop: 1 }}>
      <box style={{ flexDirection: "column", width: w }}>
        {above ?? <Wordmark ui={ui} mood={mood} suffix={VERSION} />}
        <text> </text>
        <box
          style={{
            flexDirection: "column",
            width: w,
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 1,
            paddingBottom: 1,
          }}
          border
          borderStyle={ui.plain ? "single" : "rounded"}
          customBorderChars={ui.plain ? ASCII_BORDER : undefined}
          borderColor={accent}
          title={` ${title} `}
          titleColor={accent}
          titleAlignment="left"
        >
          {children}
        </box>
        <box style={{ paddingLeft: 2, paddingTop: 1 }}>
          <text attributes={TextAttributes.DIM} wrapMode="none" truncate>
            {hint}
          </text>
        </box>
      </box>
    </box>
  );
}

/** The right pane: a slightly lighter surface than the panel, with an uppercase accent title,
 * a dim one-line subtitle, and whatever detail rows the caller has for the selected item. */
export function DetailPane({
  ui,
  heading,
  title,
  subtitle,
  children,
}: {
  ui: Ui;
  heading?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        marginLeft: 2,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
      }}
      backgroundColor={ui.plain ? undefined : tint("surface", ui.depth)}
    >
      {heading && (
        <text attributes={TextAttributes.DIM} wrapMode="none" truncate>
          {heading}
        </text>
      )}
      <text fg={tint(ACCENT, ui.depth)} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
        {title}
      </text>
      <text attributes={TextAttributes.DIM} wrapMode="none" truncate>
        {subtitle}
      </text>
      <text> </text>
      {children}
    </box>
  );
}

/** One row of a left-pane list: a filled accent bar with a ▶ marker when selected, plain
 * otherwise; `tag` is a dim trailing value (e.g. a role's "off", a rung's rung id). */
export function ListLine({
  ui,
  selected,
  dim,
  text,
  tag,
}: {
  ui: Ui;
  selected: boolean;
  dim?: boolean;
  text: string;
  tag?: string | null;
}) {
  const accent = tint(ACCENT, ui.depth);
  const filled = selected && !ui.plain;
  return (
    <box style={{ flexDirection: "row", width: "100%" }} backgroundColor={filled ? accent : undefined}>
      <text
        wrapMode="none"
        truncate
        fg={filled ? tint("ink", ui.depth) : undefined}
        attributes={(selected ? TextAttributes.BOLD : 0) | (dim && !selected ? TextAttributes.DIM : 0)}
      >
        {selected ? glyph("cursor", ui.plain) : " "} {text}
        {tag ? (
          <span attributes={filled ? TextAttributes.BOLD : TextAttributes.DIM}>{`  ${tag}`}</span>
        ) : null}
      </text>
    </box>
  );
}

const hex = (h: string): [number, number, number] => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];

/** One colour per letter, interpolated between GRADIENT's two hex stops. */
export function gradientLetters(word: string): { ch: string; fg: string }[] {
  const [a, b] = [hex(GRADIENT[0] as string), hex(GRADIENT[1] as string)];
  return [...word].map((ch, i) => {
    const t = word.length > 1 ? i / (word.length - 1) : 0;
    const rgb = a.map((c, k) => Math.round(c + ((b[k] as number) - c) * t));
    return { ch, fg: `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}` };
  });
}

/** The cat, and the wordmark it carries: `word` gradient-lettered where colour is available,
 * an optional `suffix` on the same line (the dashboard's version number), and an optional
 * second `subtitle` line (the intro's herding copy). Only place the 🐾 glyph still appears. */
export function Wordmark({
  ui,
  mood,
  word = "catherd",
  suffix,
  subtitle,
}: {
  ui: Ui;
  mood: Mood;
  word?: string;
  suffix?: string;
  subtitle?: string;
}) {
  const [ears, head, paws] = mascot(mood, ui.plain);
  const ginger = tint("ginger", ui.depth);
  return (
    <box style={{ flexDirection: "row", marginBottom: 1 }}>
      <box style={{ flexDirection: "column", marginRight: 2 }}>
        <text fg={ginger}>{ears}</text>
        <text fg={ginger}>{head}</text>
        <text fg={ginger}>{paws}</text>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
        <text wrapMode="none" truncate attributes={TextAttributes.BOLD}>
          {ui.depth >= 8 && word
            ? gradientLetters(word).map((s, i) => (
                // biome-ignore lint: index key is stable, the wordmark never reorders
                <span key={i} fg={s.fg}>
                  {s.ch}
                </span>
              ))
            : (word ?? " ")}
          {suffix ? <span attributes={TextAttributes.DIM}>{`  ${suffix}`}</span> : null}
        </text>
        {subtitle ? (
          <text fg={tint("pink", ui.depth)} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
            {subtitle}
          </text>
        ) : null}
      </box>
    </box>
  );
}

export function CatSpinner({ ui, label }: { ui: Ui; label: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (ui.reducedMotion) return;
    const t = setInterval(() => setN((x) => x + 1), SPINNER.ms);
    return () => clearInterval(t);
  }, [ui.reducedMotion]);
  const frame = SPINNER.frames[n % SPINNER.frames.length];
  const copy = herdLine(Math.floor((n * SPINNER.ms) / SPINNER.copyMs), ui.plain);
  return (
    <text wrapMode="none" truncate>
      <span fg={tint("ginger", ui.depth)}>{frame}</span> {label}{" "}
      <span attributes={TextAttributes.DIM}>
        {glyph("dot", ui.plain)} {copy}
      </span>
    </text>
  );
}

export function Intro({ ui, onDone }: { ui: Ui; onDone: () => void }) {
  const [step, setStep] = useState(ui.reducedMotion ? INTRO.steps : 0);
  useKeyboard(() => onDone());
  useEffect(() => {
    if (step >= INTRO.steps) {
      onDone();
      return;
    }
    const t = setTimeout(() => setStep(step + 1), INTRO.ms);
    return () => clearTimeout(t);
  }, [step]);
  const mood: Mood = step < 2 ? "waiting" : step < INTRO.steps ? "working" : "good";
  const word = "catherd".slice(0, Math.round((7 * step) / INTRO.steps));
  return <Wordmark ui={ui} mood={mood} word={word} subtitle={herdLine(step, ui.plain)} />;
}

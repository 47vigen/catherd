import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { GRADIENT, glyph, herdLine, INTRO, type Mood, mascot, SPINNER, tint, type Ui } from "./theme.ts";

export function Screen({ children }: { children: ReactNode }) {
  const { width } = useTerminalDimensions();
  return <box style={{ flexDirection: "column", width: Math.min(width || 80, 80) }}>{children}</box>;
}

const hex = (h: string): [number, number, number] => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];

/** One colour per letter, interpolated between GRADIENT's two hex stops. */
function gradientLetters(word: string): { ch: string; fg: string }[] {
  const [a, b] = [hex(GRADIENT[0] as string), hex(GRADIENT[1] as string)];
  return [...word].map((ch, i) => {
    const t = word.length > 1 ? i / (word.length - 1) : 0;
    const rgb = a.map((c, k) => Math.round(c + ((b[k] as number) - c) * t));
    return { ch, fg: `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}` };
  });
}

export function Header({
  ui,
  mood,
  title,
  word = "catherd",
}: {
  ui: Ui;
  mood: Mood;
  title: string;
  word?: string;
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
        {ui.depth >= 8 && word ? (
          <text attributes={TextAttributes.BOLD}>
            {gradientLetters(word).map((s, i) => (
              // biome-ignore lint: index key is stable, the wordmark never reorders
              <span key={i} fg={s.fg}>
                {s.ch}
              </span>
            ))}
          </text>
        ) : (
          <text fg={ginger} attributes={TextAttributes.BOLD}>
            {word || " "}
          </text>
        )}
        <text fg={tint("cream", ui.depth)}>herds coding agents</text>
        <text fg={tint("pink", ui.depth)} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
          {title}
        </text>
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
  return <Header ui={ui} mood={mood} title={herdLine(step, ui.plain)} word={word} />;
}

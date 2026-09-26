// Adapted from anomalyco/opencode packages/tui/src/component/spinner.tsx and startup-loading.tsx
// (MIT, © 2025 opencode); see THIRD_PARTY_NOTICES.md.
import { useEffect, useState } from "react";
import { useApp } from "../providers/app.tsx";
import { useTone, useUi } from "../providers/theme.tsx";
import { ascii } from "../text.ts";
import { SPINNER } from "../theme.ts";

/**
 * Spec §9.3 motion: true once `active` has lasted SPINNER.showAfterMs, and then for at least
 * SPINNER.minShowMs, so a quick check never flickers.
 */
export function useDelayedPresence(active: boolean): boolean {
  const { clock } = useApp();
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => {
    if (active && shownAt === null) {
      const h = clock.setTimeout(() => setShownAt(clock.now()), SPINNER.showAfterMs);
      return () => clock.clearTimeout(h);
    }
    if (!active && shownAt !== null) {
      const left = SPINNER.minShowMs - (clock.now() - shownAt);
      if (left <= 0) {
        setShownAt(null);
        return;
      }
      const h = clock.setTimeout(() => setShownAt(null), left);
      return () => clock.clearTimeout(h);
    }
    return undefined;
  }, [active, shownAt, clock]);
  return shownAt !== null;
}

/** A braille spinner and what it waits on; a still `⋯` under reduced motion (spec §9.3). */
export function Spinner(props: { label: string }) {
  const { clock } = useApp();
  const ui = useUi();
  const tone = useTone();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (ui.reducedMotion) return;
    const h = clock.setInterval(() => setFrame((f) => f + 1), SPINNER.ms);
    return () => clock.clearInterval(h);
  }, [clock, ui.reducedMotion]);
  const frames = ui.plain ? SPINNER.plainFrames : SPINNER.frames;
  const g = ui.reducedMotion ? SPINNER.still[ui.plain ? 1 : 0] : frames[frame % frames.length];
  return <text fg={tone("muted")}>{`${g} ${ui.plain ? ascii(props.label) : props.label}`}</text>;
}

import { useEffect, useState } from "react";

/** The current time in ms, ticking each second while `on`, so a live run's clocks move between reads. */
export function useTicker(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

import { useEffect, useState } from "react";

/** The current time in ms, refreshed every `everyMs` while `active`. */
export function useNow(everyMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs, active]);
  return now;
}

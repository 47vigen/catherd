import { useSyncExternalStore } from "react";

export const DESKTOP_QUERY = "(min-width: 768px)";

const subscribe = (onChange: () => void) => {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};

/** True from the `md` breakpoint up: the graph is desktop only, phones get the list of steps. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

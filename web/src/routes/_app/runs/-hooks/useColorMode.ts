import { useSyncExternalStore } from "react";

// The app's theme hook writes the resolved theme as a class on <html>; this reads it back from there, so a canvas
// with its own theme switch (React Flow) follows the toggle in the sidebar as well as the system setting.
const read = (): "dark" | "light" => (document.documentElement.classList.contains("dark") ? "dark" : "light");

const subscribe = (onChange: () => void) => {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => watch.disconnect();
};

/** The theme the page is drawn in right now. */
export function useColorMode(): "dark" | "light" {
  return useSyncExternalStore(subscribe, read, () => "dark");
}

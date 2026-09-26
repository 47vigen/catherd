import { createContext, type ReactNode, useContext } from "react";
import { paint, type Token, type Ui } from "../theme.ts";

const ThemeContext = createContext<Ui>({ plain: false, color: false, reducedMotion: true, mode: "dark" });

/** Spec §9.4 providers: the theme, one per concern. */
export function ThemeProvider(props: { ui: Ui; children: ReactNode }) {
  return <ThemeContext.Provider value={props.ui}>{props.children}</ThemeContext.Provider>;
}

export const useUi = (): Ui => useContext(ThemeContext);

/** A token's colour for this terminal: undefined under NO_COLOR and --plain. */
export function useTone(): (t: Token) => string | undefined {
  const ui = useUi();
  return (t) => paint(ui, t);
}

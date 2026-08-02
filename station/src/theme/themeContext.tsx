import { createContext, useContext, type ReactNode } from "react";
import type { StationTheme } from "./types.js";

const StationThemeContext = createContext<StationTheme | undefined>(undefined);

/** Provides one complete semantic Station theme to every renderer leaf below it. */
export function StationThemeProvider({
  theme,
  children,
}: {
  theme: StationTheme;
  children: ReactNode;
}) {
  return <StationThemeContext.Provider value={theme}>{children}</StationThemeContext.Provider>;
}

/** Returns the complete theme selected by the nearest composition-root provider. */
export function useStationTheme(): StationTheme {
  const theme = useContext(StationThemeContext);
  if (theme === undefined) {
    throw new Error("useStationTheme must be used within StationThemeProvider.");
  }
  return theme;
}

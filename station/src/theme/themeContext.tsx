import { createContext, useContext, type ReactNode } from "react";
import { builtInTheme } from "./builtInTheme.js";
import type { StationTheme } from "./types.js";

const StationThemeContext = createContext<StationTheme>(builtInTheme.native);

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

/** Production provider for the native workspace's explicit Station-dark canvas. */
export function NativeStationThemeProvider({ children }: { children: ReactNode }) {
  return <StationThemeProvider theme={builtInTheme.native}>{children}</StationThemeProvider>;
}

/** Production provider for standalone surfaces owned by the enclosing terminal. */
export function EmbeddedStationThemeProvider({ children }: { children: ReactNode }) {
  return <StationThemeProvider theme={builtInTheme.embedded}>{children}</StationThemeProvider>;
}

/** Returns the complete theme selected by the nearest composition-root provider. */
export function useStationTheme(): StationTheme {
  return useContext(StationThemeContext);
}

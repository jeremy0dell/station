import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { StationTheme } from "./types.js";

/** Renderer-neutral external store surface consumed by the active theme provider. */
export type StationThemeSource = Readonly<{
  getSnapshot(): StationTheme;
  subscribe(listener: () => void): () => void;
}>;

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

/** Subscribes a React composition root to complete snapshots from a Station theme source. */
export function useStationThemeSource(source: StationThemeSource): StationTheme {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** Returns the complete theme selected by the nearest composition-root provider. */
export function useStationTheme(): StationTheme {
  const theme = useContext(StationThemeContext);
  if (theme === undefined) {
    throw new Error("useStationTheme must be used within StationThemeProvider.");
  }
  return theme;
}

import { RGBA, type ColorInput } from "@opentui/core";
import { createContext, useContext, type ReactNode } from "react";
import { STATION_COLORS } from "./theme.js";

/** Background ownership for shared dashboard surfaces. */
export type DashboardSurfacePolicy = Readonly<{
  surfaceBackground: ColorInput;
  overlayBackground: ColorInput;
}>;

const STATION_DEFAULT_SURFACES = {
  surfaceBackground: STATION_COLORS.background,
  overlayBackground: STATION_COLORS.overlayBackdrop,
} satisfies DashboardSurfacePolicy;

// Default intent paints opaque terminal cells; this RGB value is only OpenTUI's fallback snapshot.
export const TERMINAL_DEFAULT_SURFACES = {
  surfaceBackground: RGBA.defaultBackground(STATION_COLORS.background),
  overlayBackground: RGBA.defaultBackground(STATION_COLORS.background),
} satisfies DashboardSurfacePolicy;

const DashboardSurfaceContext =
  createContext<DashboardSurfacePolicy>(STATION_DEFAULT_SURFACES);

/** Overrides surface ownership for a dashboard renderer composition. */
export function DashboardSurfaceProvider({
  value,
  children,
}: {
  value: DashboardSurfacePolicy;
  children: ReactNode;
}) {
  return (
    <DashboardSurfaceContext.Provider value={value}>
      {children}
    </DashboardSurfaceContext.Provider>
  );
}

/** Returns the background roles owned by the active dashboard composition. */
export function useDashboardSurfaces(): DashboardSurfacePolicy {
  return useContext(DashboardSurfaceContext);
}

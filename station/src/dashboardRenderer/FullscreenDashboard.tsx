import type { MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiStore } from "@station/dashboard-core";
import { useCallback } from "react";
import type { StoreApi } from "zustand/vanilla";
import { DashboardRoot } from "../station/view/DashboardRoot.js";
import { StationMouseProvider, type StationMouseDispatch } from "../station/view/stationMouseContext.js";

/**
 * The standalone dashboard, rendered to fill the terminal. This is the
 * fullscreen counterpart to Station's in-app `StationOverlay`: it drops the
 * backdrop, centering, and border so the same `DashboardRoot` owns the whole
 * screen (the CLI `tui`/`popup` surface that replaced the retired Ink UI).
 *
 * Mouse is scroll-only: row launch / new-session come from the keyboard
 * (1-9/a-z, Enter), matching the Ink TUI it replaces. Wheel scroll feeds the
 * same scroll path keyboard scrolling uses.
 */
export function FullscreenDashboard({ store }: { store: StoreApi<TuiStore> }) {
  const { width, height } = useTerminalDimensions();
  const dispatch = useCallback<StationMouseDispatch>(
    (target, event: MouseEvent) => {
      if (target.kind !== "body" && target.kind !== "scrollIndicator") {
        return;
      }
      const direction = event.scroll?.direction;
      if (direction === "up" || direction === "down") {
        store.getState().handleKey({ input: "", mouseScroll: direction });
      }
    },
    [store],
  );
  return (
    <StationMouseProvider value={dispatch}>
      <box width={width} height={height} flexDirection="column">
        <DashboardRoot store={store} columns={width} rows={height} />
      </box>
    </StationMouseProvider>
  );
}

import type { MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { TuiStore } from "@station/dashboard-core";
import { useCallback } from "react";
import type { StoreApi } from "zustand/vanilla";
import { normalizeStationMouseEvent } from "../input/mouse.js";
import { DashboardRoot } from "../station/view/DashboardRoot.js";
import { StationMouseProvider, type StationMouseDispatch } from "../station/view/stationMouseContext.js";
import { routeDashboardMouse } from "./dashboardMouse.js";

/**
 * The standalone dashboard, rendered to fill the terminal. This is the
 * fullscreen counterpart to Station's in-app `StationOverlay`: it drops the
 * backdrop, centering, and border so the same `DashboardRoot` owns the whole
 * screen (the CLI `tui`/`popup` surface that replaced the retired Ink UI).
 *
 * Mouse targets route through the standalone dashboard adapter, which reuses
 * keyboard/core transitions while excluding native pane-only outcomes.
 */
export function FullscreenDashboard({ store }: { store: StoreApi<TuiStore> }) {
  const { width, height } = useTerminalDimensions();
  const dispatch = useCallback<StationMouseDispatch>(
    (target, event: MouseEvent) => {
      routeDashboardMouse(target, normalizeStationMouseEvent(event), store);
    },
    [store],
  );
  return (
    <StationMouseProvider value={dispatch}>
      <box width={width} height={height} flexDirection="column">
        <DashboardRoot
          store={store}
          columns={width}
          rows={height}
          showNativeProjectActions={false}
        />
      </box>
    </StationMouseProvider>
  );
}

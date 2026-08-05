import type { DashboardActions } from "@station/dashboard-core";
import type { KeymapLayer } from "../../input/keymap/keymaps.js";
import type { RouteOutcome } from "../../input/router.js";
import { STATION_OVERLAY_ID } from "../../state/types.js";
import { handleStationSequence } from "./stationActions.js";

type StationOverlayDashboard = {
  actions: Pick<DashboardActions, "handleKey">;
};

/** Translate and dispatch native overlay input; semantic capabilities own every effect. */
export function createStationOverlayLayer(
  dashboardRuntime: StationOverlayDashboard,
): KeymapLayer<RouteOutcome> {
  return {
    id: "overlay",
    isActive: (state) => state.input.activeOverlay === STATION_OVERLAY_ID,
    bindings: [],
    catchAll: (sequence) => {
      handleStationSequence(dashboardRuntime, sequence);
      return { kind: "swallowed" };
    },
  };
}

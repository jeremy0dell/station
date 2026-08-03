// The STATION dashboard runtime is fed by Station's client source and owned by
// createStation.ts, so search, collapse, and scroll state survive overlay
// toggles; overlayRowFocus separately treats row focus as transient. Native
// Station is always a persistent popup whose dismiss is executed by the router,
// so onDismiss records that capability without owning the effect.
import {
  createDashboardRuntime,
  legacySearchExperience,
  type DashboardRuntime,
  type DashboardSearchExperience,
  type TuiFolderService,
} from "@station/dashboard-core";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets/types";
import type { StationClient } from "../../sources/types.js";

/** Options for Station's native dashboard-runtime composition. */
export type CreateStationDashboardRuntimeOptions = {
  folderService?: TuiFolderService;
  /** Resolved at renderer composition; defaults only for direct/test callers. */
  dashboardSearchExperience?: DashboardSearchExperience;
  /** `[tui].widgets` seed for the session's live widget set. */
  widgets?: readonly TuiWidgetConfig[];
  /** False when widget edits cannot be written back to config.toml. */
  widgetsPersisted?: boolean;
};

/** Create Station's dashboard runtime over the native renderer's client source. */
export function createStationDashboardRuntime(
  client: StationClient,
  options: CreateStationDashboardRuntimeOptions = {},
): DashboardRuntime {
  const runtimeOptions: Parameters<typeof createDashboardRuntime>[0] = {
    source: client.state,
    service: client.service,
    clientLabel: "Station",
    dashboardSearchExperience: options.dashboardSearchExperience ?? legacySearchExperience,
    persistentPopup: true,
    onDismiss: async () => {
      // Dismiss is the router's job: the overlay layer maps the transition's
      // dismissPopup to an overlay-close outcome and executeOutcome closes
      // via the coordination store. This callback exists only so the shared
      // machine sees canDismissPopup=true.
    },
  };
  if (options.folderService !== undefined) {
    runtimeOptions.folderService = options.folderService;
  }
  const initialState: NonNullable<typeof runtimeOptions.initialState> = {};
  if (options.widgets !== undefined) {
    initialState.widgets = options.widgets;
  }
  if (options.widgetsPersisted !== undefined) {
    initialState.widgetsPersisted = options.widgetsPersisted;
  }
  runtimeOptions.initialState = initialState;
  return createDashboardRuntime(runtimeOptions);
}

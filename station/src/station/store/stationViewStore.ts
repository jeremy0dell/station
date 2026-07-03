// The STATION view's store: the shared TuiState machine fed by Station's source
// boundary. main.tsx owns the instance (view state survives overlay toggles
// because the store outlives the overlay component). The runtime flags pin the
// popup posture:
// in Station the STATION view is always a persistent popup whose dismiss is
// executed by the router (overlay-close outcome) — the store-level onDismiss
// is a recorded no-op so canDismissPopup derives true and Q/Esc produce
// dismissPopup transitions instead of exitCode.
import type { StoreApi } from "zustand/vanilla";
import type { StationClient } from "../../sources/types.js";
import type { TuiFolderService } from "@station/dashboard-core";
import { createTuiStore, type TuiStore } from "@station/dashboard-core";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets/types";

export type CreateStationViewStoreOptions = {
  folderService?: TuiFolderService;
  /** `[tui].widgets` seed for the session's live widget set. */
  widgets?: readonly TuiWidgetConfig[];
  /** False when widget edits cannot be written back to config.toml. */
  widgetsPersisted?: boolean;
};

export function createStationViewStore(
  client: StationClient,
  options: CreateStationViewStoreOptions = {},
): StoreApi<TuiStore> {
  const storeOptions: Parameters<typeof createTuiStore>[0] = {
    source: client.state,
    service: client.service,
    clientLabel: "Station",
    persistentPopup: true,
    onDismiss: async () => {
      // Dismiss is the router's job: the overlay layer maps the transition's
      // dismissPopup to an overlay-close outcome and executeOutcome closes
      // via the coordination store. This callback exists only so the shared
      // machine sees canDismissPopup=true.
    },
  };
  if (options.folderService !== undefined) {
    storeOptions.folderService = options.folderService;
  }
  const initialState: NonNullable<typeof storeOptions.initialState> = {};
  if (options.widgets !== undefined) {
    initialState.widgets = options.widgets;
  }
  if (options.widgetsPersisted !== undefined) {
    initialState.widgetsPersisted = options.widgetsPersisted;
  }
  storeOptions.initialState = initialState;
  return createTuiStore(storeOptions);
}

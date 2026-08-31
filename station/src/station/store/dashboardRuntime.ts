// createStation.ts owns one semantic runtime and its renderer scroll controller,
// so filter/collapse plus measured scroll/follow survive overlay toggles;
// overlayRowFocus separately treats row focus as transient. Native Station is
// always a persistent popup whose dismiss is executed by the router, so
// onDismiss records that capability without owning the effect.
import { createDashboardRuntime } from "@station/dashboard-core/runtime";
import type { DashboardCapabilities, DashboardRuntime, TuiFolderService } from "@station/dashboard-core/runtime";
import type { DashboardGroupHeaderActionVisibility } from "@station/dashboard-core/state";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets";
import type { StationClient } from "../../sources/types.js";
import { stationHelpEntryOrder } from "../helpEntries.js";
import {
  createDashboardScrollController,
  type DashboardScrollController,
} from "../view/layout/scroll/dashboardScrollController.js";

export type StationDashboardRuntime = DashboardRuntime & {
  /** Canonical snapshot/connection authority paired with this dashboard projection. */
  clientState: StationClient["state"];
  layout: DashboardScrollController;
};

/** Options for Station's native dashboard-runtime composition. */
export type CreateStationDashboardRuntimeOptions = {
  /** Required composition dependency; dashboard-core has no filesystem fallback. */
  folderService: TuiFolderService;
  /** `[tui].widgets` seed for the session's live widget set. */
  widgets?: readonly TuiWidgetConfig[];
  /** False when widget edits cannot be written back to config.toml. */
  widgetsPersisted?: boolean;
  /** Optional Group header action visibility overrides. */
  groupHeaderActionVisibility?: Partial<DashboardGroupHeaderActionVisibility>;
  layout?: DashboardScrollController;
};

/**
 * Create Station's dashboard projection paired with its canonical client source.
 * Its asynchronous repeat-safe disposal drains admitted dashboard work before the
 * owning Station composition stops the shared client.
 */
export function createStationDashboardRuntime(
  client: StationClient,
  capabilities: DashboardCapabilities,
  options: CreateStationDashboardRuntimeOptions,
): StationDashboardRuntime {
  const layout = options.layout ?? createDashboardScrollController();
  const runtimeOptions: Parameters<typeof createDashboardRuntime>[0] = {
    source: client.state,
    service: client.service,
    capabilities,
    clientLabel: "Station",
    visibleDashboardRows: layout.visibleRows,
    helpEntries: stationHelpEntryOrder,
    folderService: options.folderService,
  };
  const initialState: NonNullable<typeof runtimeOptions.initialState> = {};
  if (options.widgets !== undefined) {
    initialState.widgets = options.widgets;
  }
  if (options.widgetsPersisted !== undefined) {
    initialState.widgetsPersisted = options.widgetsPersisted;
  }
  if (options.groupHeaderActionVisibility !== undefined) {
    initialState.groupHeaderActionVisibility = options.groupHeaderActionVisibility;
  }
  runtimeOptions.initialState = initialState;
  const runtime = createDashboardRuntime(runtimeOptions);
  return { ...runtime, clientState: client.state, layout };
}

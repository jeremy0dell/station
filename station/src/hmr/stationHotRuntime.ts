import type { UiRunId } from "@station/contracts";
import type { WorkspaceConfig } from "../config/stationConfig.js";
import { createStationStore, type StationStore } from "../state/store.js";
import type { WorkspaceSlice } from "../state/types.js";
import { createPtyRegistry, type PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import type { StationHotDisposalSlots } from "./hotDisposalBarrier.js";

// Bump only when a code change makes a preserved store/registry unsafe to reuse
// across a hot reload (e.g. an incompatible store-state shape). A mismatch
// triggers a clean reboot rather than reusing stale in-memory state.
// v3: registry/screens gained corruption detectors and geometry checks; a
// preserved v2 registry would leave hot-reloaded panes without them.
// v4: registries gained configurable scrollback; a preserved v3 registry would
// ignore the refreshed depth when lazily creating screens after a hot reload.
// v5: registries/screens gained the terminal-projection update seam and exact
// exited-entry recycling with stale-callback guards; a preserved v4 registry
// cannot accept the native composition's projection refresh or safely relaunch
// a retained managed pane.
// v6: stores gained a shared managed-launch flight guard; a preserved v5 store
// could let old and replacement HMR compositions prepare the same pane concurrently.
export const STATION_HOT_RUNTIME_VERSION = 6;

export type StationHotRenderer = { destroy(): void };

export type StationHotRuntime = {
  version: number;
  store: StationStore;
  registry: PtyRegistry;
};

export type StationHotSlots = StationHotDisposalSlots & {
  __stationHotRuntime?: StationHotRuntime;
  __stationHotRenderer?: StationHotRenderer;
  __stationUiRunId?: UiRunId;
};

export function stationHotSlots(): StationHotSlots {
  return globalThis as StationHotSlots;
}

/**
 * Reuse compatible HMR state so live panes and PTYs survive code edits; version
 * mismatch disposes and rebuilds. Disk restore seeds only clean boots, never the
 * reuse path, to avoid clobbering the in-memory layout.
 */
export function getOrCreateStationHotRuntime(
  slots: StationHotSlots,
  config: WorkspaceConfig,
  initialWorkspace?: WorkspaceSlice,
): StationHotRuntime {
  const existing = slots.__stationHotRuntime;
  if (existing?.version === STATION_HOT_RUNTIME_VERSION) {
    return existing;
  }
  // disposeAll tears down each entry's subscriptions before its terminal, so no
  // stale onExit fires during the reboot; the discarded registry needs no
  // further handler cleanup.
  existing?.registry.disposeAll();

  const storeOptions =
    initialWorkspace === undefined
      ? { boot: "empty" as const, welcomeIntroOnBoot: config.welcome_on_boot }
      : { initialWorkspace, welcomeIntroOnBoot: config.welcome_on_boot };
  const runtime: StationHotRuntime = {
    version: STATION_HOT_RUNTIME_VERSION,
    store: createStationStore(storeOptions),
    registry: createPtyRegistry({
      scrollOnOutput: config.scroll_on_output,
      scrollbackLines: config.scrollback_lines,
    }),
  };
  slots.__stationHotRuntime = runtime;
  return runtime;
}

import type { TuiStore } from "@station/dashboard-core";
import type {
  TopRowWidgetRuntimeDeps,
  TuiConfig,
  TuiWidgetConfig,
} from "@station/dashboard-core/widgets/types";
import type { StoreApi } from "zustand/vanilla";
import type { Automation, ScrollOnOutputMode } from "../config/stationConfig.js";
import type { ClipboardEffects } from "../copy/clipboard.js";
import type { StationInputRuntime } from "../input/stationInput.js";
import type { StationLayoutSnapshot } from "../state/layout/layoutSnapshot.js";
import type { StationStore } from "../state/store.js";
import type { StationClient } from "../sources/types.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";

/** Props for the pure `<StationApp />` view; `createStation` builds these. */
export type StationAppProps = {
  store: StationStore;
  registry: PtyRegistry;
  stationViewStore: StoreApi<TuiStore>;
  dispatchMouse: StationInputRuntime["dispatchMouse"];
  onCopySelection: (text: string) => void;
  /** Configured automations surfaced in the pane context menu. */
  automations: readonly Automation[];
  widgets?: readonly TuiWidgetConfig[];
  topRowWidgetDeps?: TopRowWidgetRuntimeDeps;
};

export type CreateStationOptions = {
  store: StationStore;
  stationClient: StationClient;
  shutdown(): void;
  /** Real copy sinks (OSC 52 + a clipboard CLI); tests pass NO_OP_CLIPBOARD_EFFECTS. */
  clipboardEffects: ClipboardEffects;
  createTerminal?: (options: StationTerminalSpawnOptions) => StationTerminalProcess;
  /**
   * Close the STATION overlay when a `[+sh]` shell pane opens so the shell shows at
   * once. Default (false) keeps the overlay up and queues the pane as return focus.
   */
  shellAutoCloseOverlay?: boolean;
  /** Scroll-position-on-output policy for panes; default freeze. */
  scrollOnOutput?: ScrollOnOutputMode;
  /** Configured automations surfaced in the pane context menu; default none. */
  automations?: readonly Automation[];
  openExternalUrl?: (url: string) => void;
  tuiConfig?: TuiConfig;
  topRowWidgetDeps?: TopRowWidgetRuntimeDeps;
  /** Existing registry to reuse across Bun HMR without killing live PTYs. */
  registry?: PtyRegistry;
  /**
   * Station-host socket path. When set, aux shells spawn into the host (warm
   * reattach across UI restarts) when it is up, falling back to a local shell
   * otherwise. Absent in tests/mock mode ⇒ aux shells are always local.
   */
  hostSocketPath?: string;
  /**
   * Persist the aux-pane layout to disk so a cold restart restores it. Absent in
   * tests/mock mode. `write` is a test seam; main supplies the state-dir path and
   * the default atomic writer.
   */
  layout?: {
    path: string;
    write?: (snapshot: StationLayoutSnapshot) => void;
    debounceMs?: number;
  };
};

export type Station = {
  /** Props for <StationApp />; the renderer owns mounting (main.tsx / tests). */
  viewProps: StationAppProps;
  store: StationStore;
  registry: PtyRegistry;
  stationViewStore: StoreApi<TuiStore>;
  stationInput: StationInputRuntime;
  start(): void;
  dispose(): void;
  disposeForShutdown(): void;
  disposeForHotReload(): void;
};

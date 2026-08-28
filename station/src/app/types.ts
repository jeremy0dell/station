import type { StationClientStateSource } from "@station/client";
import type { DashboardActions, DashboardRuntime, DashboardStateSource } from "@station/dashboard-core/runtime";
import type {
  TopRowWidgetRuntimeDeps,
  TuiConfig,
  TuiIslandConfig,
} from "@station/dashboard-core/widgets";
import type { Automation, ScrollOnOutputMode } from "../config/stationConfig.js";
import type { ClipboardEffects } from "../copy/clipboard.js";
import type { StationInputRuntime } from "../input/stationInput.js";
import type { StationLayoutSnapshot } from "../state/layout/layoutSnapshot.js";
import type { StationStore } from "../state/store.js";
import type { StationClient } from "../sources/types.js";
import type { AuxShellPlacement } from "../terminal/pty/auxShellPlacement.js";
import type { ManagedTerminalAttacher } from "../terminal/pty/managedTerminalAttacher.js";
import type { DashboardScrollController } from "../station/view/layout/scrollViewport.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";

/** Props for the pure `<StationApp />` view with canonical client truth separated from dashboard projection. */
export type StationAppProps = {
  store: StationStore;
  registry: PtyRegistry;
  dashboardState: DashboardStateSource;
  clientState: StationClientStateSource;
  dashboardActions: Pick<DashboardActions, "expireToasts" | "refreshActiveToastExpiry">;
  dashboardLayout: DashboardScrollController;
  dispatchMouse: StationInputRuntime["dispatchMouse"];
  onCopySelection: (text: string) => void;
  /** Configured automations surfaced in the pane context menu. */
  automations: readonly Automation[];
  overlayWidthPercent?: number;
  overlayHeightPercent?: number;
  /** Opt-in island display modes from `[tui.island]`. */
  island?: TuiIslandConfig;
  topRowWidgetDeps?: TopRowWidgetRuntimeDeps;
};

export type CreateStationOptions = {
  store: StationStore;
  stationClient: StationClient;
  /**
   * Synchronously admits shutdown once to the enclosing owner, which must drive
   * and observe `disposeForShutdown()` before terminating the process.
   */
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
  /** Normal-buffer history retained per new pane, bounded by the workspace safety ceiling. */
  scrollbackLines?: number;
  /** Native Station overlay size as terminal percentages; defaults come from `[workspace]`. */
  overlayWidthPercent?: number;
  overlayHeightPercent?: number;
  /** Configured automations surfaced in the pane context menu; default none. */
  automations?: readonly Automation[];
  openExternalUrl?: (url: string) => void;
  tuiConfig?: TuiConfig;
  tuiConfigPath?: string;
  topRowWidgetDeps?: TopRowWidgetRuntimeDeps;
  /** Existing registry to reuse across Bun HMR without killing live PTYs. */
  registry?: PtyRegistry;
  /** Composition-supplied host placement; absent means aux shells remain local. */
  resolveAuxShellPlacement?: AuxShellPlacement;
  /** Composition-supplied resolver for observer-advertised managed terminals. */
  managedTerminalAttacher?: ManagedTerminalAttacher;
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
  /** Dashboard state, mutation authority, and lifecycle owned by this Station composition. */
  dashboard: DashboardRuntime;
  stationInput: StationInputRuntime;
  start(): void;
  dispose(): void;
  /** Memoized shutdown drain the enclosing owner must observe before termination. */
  disposeForShutdown(): Promise<void>;
  /** Retain PTYs and workspace state while draining dashboard work before HMR replacement. */
  disposeForHotReload(): Promise<void>;
};

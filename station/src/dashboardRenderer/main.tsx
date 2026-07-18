// Standalone OpenTUI dashboard renderer — the sole STATION dashboard UI after the
// Ink TUI (apps/tui) was retired. The Node CLI (`stn tui` / persistent popup)
// starts the observer and spawns this entry under Bun for both fullscreen and
// popup; it renders Station's dashboard view over the observer socket and
// dispatches the same observer commands the Ink TUI did (no Station panes).
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createTuiStore } from "@station/dashboard-core";
import {
  loadStationTuiConfig,
  startWidgetConfigWrites,
  type WidgetConfigWrites,
} from "../config/tuiConfig.js";
import { STATION_KEYBOARD_PROTOCOL } from "../input/keyboardProtocol.js";
import { openExternalUrl } from "../openUrl.js";
import { createStationClient } from "../sources/createStationClient.js";
import { sanitizePastedText } from "../station/input/sequenceToTuiKey.js";
import type { DashboardMouseEffects } from "./dashboardMouse.js";
import { FullscreenDashboard } from "./FullscreenDashboard.js";
import { createDashboardSequenceHandler } from "./inputBridge.js";
import {
  createPopupRuntime,
  createProcessRendererControlChannel,
} from "./popupRuntime.js";

type DashboardHotRenderer = { destroy(): void };
type DashboardHotRoot = { unmount(): void };
type DashboardHotSlots = typeof globalThis & {
  __stationDashboardHotDispose?: () => void;
  __stationDashboardHotRenderer?: DashboardHotRenderer;
};

function dashboardHotSlots(): DashboardHotSlots {
  return globalThis as DashboardHotSlots;
}

/**
 * Callable entry for the interactive observer-backed dashboard without native Station panes.
 * Configured widgets seed the live store and share the config-write subscription;
 * normal process exits await widget durability before releasing renderer resources.
 */
export async function runDashboardMain(): Promise<void> {
  const env = process.env;
  const hotSlots = dashboardHotSlots();

  // The prior OpenTUI owner must release process-global stdin synchronously before replacement.
  hotSlots.__stationDashboardHotDispose?.();
  hotSlots.__stationDashboardHotRenderer?.destroy();

  const tuiConfig = await loadStationTuiConfig({ env });
  // Print config degradation before OpenTUI takes over the terminal.
  if (tuiConfig.warning !== undefined) {
    console.error(`[station] ${tuiConfig.warning}`);
  }

  let disposeResources = (): void => {};
  let widgetConfigWrites: WidgetConfigWrites | undefined;
  let exiting = false;
  function exit(code: number): void {
    if (exiting) {
      return;
    }
    exiting = true;
    void (async () => {
      if (widgetConfigWrites !== undefined) {
        await widgetConfigWrites.dispose();
      }
      disposeResources();
      process.exit(code);
    })();
  }
  const popupRuntime = createPopupRuntime(
    env,
    createProcessRendererControlChannel(),
    () => exit(1),
  );

  const client = createStationClient(env);
  const store = createTuiStore({
    source: client.state,
    service: client.service,
    clientLabel: "station",
    onExit: exit,
    initialState: {
      widgets: tuiConfig.config?.widgets ?? [],
      widgetsPersisted: tuiConfig.configPath !== undefined,
    },
    ...popupRuntime.storeOptions,
  });
  const mouseEffects: DashboardMouseEffects = {
    openShell: ({ cwd }) => {
      const openShell = popupRuntime.openShell;
      if (openShell === undefined) {
        store.getState().pushToast({
          kind: "error",
          message: "Opening a shell is unavailable outside native Station or a tmux popup.",
        });
        return;
      }
      void openShell(cwd).catch(() => {
        store.getState().pushToast({
          kind: "error",
          message: "The tmux popup could not open the requested shell.",
        });
      });
    },
    openUrl: openExternalUrl,
  };
  if (tuiConfig.configPath !== undefined) {
    widgetConfigWrites = startWidgetConfigWrites(store, tuiConfig.configPath);
  }

  // Attach the snapshot source first, then start the client runtime feeding it
  // (the order Station's lifecycle uses), so the first frame already sees the
  // connection state instead of a stale "disconnected".
  const detachSource = store.getState().start();
  client.start();

  let disposed = false;
  let renderer: DashboardHotRenderer | undefined;
  let root: DashboardHotRoot | undefined;
  const onProcessExit = (): void => disposeResources();
  disposeResources = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    root?.unmount();
    popupRuntime.dispose();
    void widgetConfigWrites?.dispose();
    detachSource();
    void client.stop();
    renderer?.destroy();
    process.off("exit", onProcessExit);
    if (hotSlots.__stationDashboardHotDispose === disposeResources) {
      delete hotSlots.__stationDashboardHotDispose;
    }
    if (hotSlots.__stationDashboardHotRenderer === renderer) {
      delete hotSlots.__stationDashboardHotRenderer;
    }
  };

  try {
    const nextRenderer = await createCliRenderer({
      // Tmux 3.7 treats buttonless SGR motion outside a popup as its button-3 menu.
      enableMouseMovement: env.STATION_TUI_POPUP !== "1",
      exitOnCtrlC: false,
      prependInputHandlers: [createDashboardSequenceHandler(store)],
      useKittyKeyboard: STATION_KEYBOARD_PROTOCOL,
    });
    renderer = nextRenderer;
    hotSlots.__stationDashboardHotRenderer = nextRenderer;
    hotSlots.__stationDashboardHotDispose = disposeResources;
    // OpenTUI routes paste around the sequence handlers; forward it as sanitized
    // text so a paste into search / the new-session name lands as input.
    nextRenderer.keyInput.on("paste", (event) => {
      const text = sanitizePastedText(new TextDecoder().decode(event.bytes));
      if (text.length > 0) {
        store.getState().handleKey({ input: text });
      }
    });

    const nextRoot = createRoot(nextRenderer);
    root = nextRoot;
    nextRoot.render(<FullscreenDashboard store={store} effects={mouseEffects} />);
    process.on("exit", onProcessExit);

    if (import.meta.hot) {
      import.meta.hot.accept();
      import.meta.hot.dispose(disposeResources);
    }
  } catch (error) {
    disposeResources();
    throw error;
  }
}

if (import.meta.main) {
  await runDashboardMain();
}

// Standalone OpenTUI dashboard renderer — the sole STATION dashboard UI after the
// Ink TUI (apps/tui) was retired. The Node CLI (`stn tui` / persistent popup)
// starts the observer and spawns this entry under Bun for both fullscreen and
// popup; it renders Station's dashboard view over the observer socket and
// dispatches the same observer commands the Ink TUI did (no Station panes).
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { toSafeError } from "@station/client";
import { createDashboardRuntime } from "@station/dashboard-core/runtime";
import {
  loadStationTuiConfig,
  startWidgetConfigWrites,
  type WidgetConfigWrites,
} from "../config/tuiConfig.js";
import { copyToClipboard, DEFAULT_COPY_SINKS } from "../copy/clipboard.js";
import { createOpenTuiSelectionCopyHandler } from "../copy/openTuiSelection.js";
import { createRuntimeClipboardEffects } from "../copy/runtimeClipboard.js";
import { STATION_KEYBOARD_PROTOCOL } from "../input/keyboardProtocol.js";
import { DecMode } from "../terminal/protocol/decset.js";
import { CsiCommand } from "../terminal/protocol/identifiers.js";
import { VtPrefix } from "../terminal/protocol/syntax.js";
import { openExternalUrl } from "../openUrl.js";
import { createStationClient } from "../sources/createStationClient.js";
import { sanitizePastedText } from "../station/input/sequenceToTuiKey.js";
import { createDashboardScrollController } from "../station/view/layout/scrollViewport.js";
import {
  createStationThemeController,
  type StationThemeController,
} from "../theme/index.js";
import { createDashboardCapabilities } from "./dashboardCapabilities.js";
import { createDashboardSequenceHandler } from "./inputBridge.js";
import { StandaloneDashboardApp } from "./StandaloneDashboardApp.js";
import {
  createPopupRuntime,
  createProcessRendererControlChannel,
} from "./popupRuntime.js";
import {
  beginHotDisposal,
  type StationHotDisposalSlots,
  waitForHotDisposal,
} from "../hmr/hotDisposalBarrier.js";
import { invokeCleanup } from "../lifecycle/cleanup.js";
import {
  createDashboardRendererRuntimeLifecycle,
  type DashboardRendererRuntimeLifecycle,
} from "./runtimeLifecycle.js";

type DashboardRenderer = Pick<CliRenderer, "destroy" | "getSelection">;
type DashboardHotRoot = { unmount(): void };
type DashboardRendererHotSlots = StationHotDisposalSlots & {
  __stationDashboardHotRenderer?: DashboardRenderer;
};

/**
 * Callable entry for the interactive observer-backed dashboard without native Station panes.
 * Configured widgets seed the live store and share the config-write subscription;
 * disposal releases renderer ownership synchronously, then drains dashboard work and
 * widget durability before normal process exit.
 */
export async function runDashboardMain(): Promise<void> {
  const env = process.env;
  const hotSlots = globalThis as DashboardRendererHotSlots;
  const clipboardEffects = createRuntimeClipboardEffects({
    env,
    platform: process.platform,
    writeToHost: (sequence) => process.stdout.write(sequence),
  });

  // The prior OpenTUI owner must release process-global stdin synchronously before replacement.
  await invokeCleanup(() => hotSlots.__stationDashboardHotRenderer?.destroy()).catch(
    reportDashboardHotDisposalFailure,
  );
  await waitForHotDisposal(hotSlots);

  const tuiConfig = await loadStationTuiConfig({ env });
  // Print config degradation before OpenTUI takes over the terminal.
  if (tuiConfig.warning !== undefined) {
    console.error(`[station] ${tuiConfig.warning}`);
  }

  let runtimeLifecycle: DashboardRendererRuntimeLifecycle | undefined;
  let widgetConfigWrites: WidgetConfigWrites | undefined;
  let exiting = false;
  function exit(code: number): void {
    if (exiting) {
      return;
    }
    exiting = true;
    const settlement = runtimeLifecycle?.dispose() ?? Promise.resolve();
    void settlement.then(
      () => process.exit(code),
      (error: unknown) => {
        reportDashboardHotDisposalFailure(error);
        process.exit(code === 0 ? 1 : code);
      },
    );
  }
  const popupRuntime = createPopupRuntime(
    env,
    createProcessRendererControlChannel(),
    () => exit(1),
  );

  const client = createStationClient(env);
  const capabilities = createDashboardCapabilities({
    clientState: client.state,
    observerService: client.service,
    popupRuntime,
    exitRenderer: exit,
  });
  const dashboardLayout = createDashboardScrollController();
  const dashboardRuntime = createDashboardRuntime({
    source: client.state,
    service: client.service,
    capabilities,
    clientLabel: "station",
    visibleDashboardRows: dashboardLayout.visibleRows,
    initialState: {
      widgets: tuiConfig.config?.widgets ?? [],
      widgetsPersisted: tuiConfig.configPath !== undefined,
    },
  });
  const dashboardInput = {
    state: dashboardRuntime.state,
    actions: dashboardRuntime.actions,
    layout: dashboardLayout,
  };
  const copyNoticeText = (text: string): void => {
    copyToClipboard(text, DEFAULT_COPY_SINKS, clipboardEffects);
  };
  if (tuiConfig.configPath !== undefined) {
    widgetConfigWrites = startWidgetConfigWrites(
      dashboardRuntime.state,
      dashboardRuntime.actions.pushToast,
      tuiConfig.configPath,
    );
  }

  // Attach the snapshot source first, then start the client runtime feeding it
  // (the order Station's lifecycle uses), so the first frame already sees the
  // connection state instead of a stale "disconnected".
  dashboardRuntime.start();
  client.start();

  let renderer: DashboardRenderer | undefined;
  let root: DashboardHotRoot | undefined;
  let themeController: StationThemeController | undefined;
  const onProcessExit = (): void => runtimeLifecycle?.disposeForProcessExit();
  runtimeLifecycle = createDashboardRendererRuntimeLifecycle({
    releaseRendererResources: [
      () => root?.unmount(),
      () => themeController?.dispose(),
      () => renderer?.destroy(),
      () => {
        process.off("exit", onProcessExit);
      },
      () => {
        if (hotSlots.__stationDashboardHotRenderer === renderer) {
          delete hotSlots.__stationDashboardHotRenderer;
        }
      },
    ],
    disposeWidgetWrites: () => widgetConfigWrites?.dispose() ?? Promise.resolve(),
    disposeDashboardRuntime: () => Promise.resolve(dashboardRuntime.dispose()),
    disposeRuntimeCapabilities: () => popupRuntime.dispose(),
    stopClient: () => client.stop(),
  });

  // tmux 3.7 can open its button-3 menu while Station reports mouse movement.
  // Re-enable popup movement once Station requires a tmux release containing
  // tmux/tmux@ad6832e, which removes the popup menu.
  const popupRenderer = env.STATION_TUI_POPUP === "1";
  const enableMouseMovement = !popupRenderer;

  try {
    const copySelectedText = createOpenTuiSelectionCopyHandler(() => renderer, clipboardEffects);
    const nextRenderer = await createCliRenderer({
      enableMouseMovement,
      exitOnCtrlC: false,
      prependInputHandlers: [
        copySelectedText,
        createDashboardSequenceHandler(dashboardRuntime),
      ],
      useKittyKeyboard: STATION_KEYBOARD_PROTOCOL,
    });
    renderer = nextRenderer;
    const nextThemeController = createStationThemeController(nextRenderer);
    themeController = nextThemeController;
    // The controller begins on the complete fallback; palette I/O must not block the first frame.
    void nextThemeController.start();
    if (popupRenderer) {
      // OpenTUI keeps 1002 drag tracking on when 1003 movement is off; popups need click-only 1000 + 1006.
      process.stdout.write(
        `${VtPrefix.Csi}${CsiCommand.ResetDecPrivateMode.prefix}${DecMode.MouseButtonEvent}${CsiCommand.ResetDecPrivateMode.final}` +
          `${VtPrefix.Csi}${CsiCommand.SetDecPrivateMode.prefix}${DecMode.MouseVt200}${CsiCommand.SetDecPrivateMode.final}`,
      );
    }
    hotSlots.__stationDashboardHotRenderer = nextRenderer;
    // OpenTUI routes paste around the sequence handlers; forward it as sanitized
    // text so a paste into search / the new-session name lands as input.
    nextRenderer.keyInput.on("paste", (event) => {
      const text = sanitizePastedText(new TextDecoder().decode(event.bytes));
      if (text.length > 0) {
        dashboardRuntime.actions.handleKey({ input: text });
      }
    });
    const nextRoot = createRoot(nextRenderer);
    root = nextRoot;
    nextRoot.render(
      <StandaloneDashboardApp
        runtime={dashboardInput}
        openUrl={openExternalUrl}
        onCopyNotice={copyNoticeText}
        hoverEnabled={!popupRenderer}
        themeSource={nextThemeController}
      />,
    );
    process.on("exit", onProcessExit);

    if (import.meta.hot) {
      import.meta.hot.accept();
      import.meta.hot.dispose(() => {
        beginHotDisposal(
          hotSlots,
          () => runtimeLifecycle.dispose(),
          reportDashboardHotDisposalFailure,
        );
      });
    }
  } catch (error) {
    try {
      await runtimeLifecycle.dispose();
    } catch (cleanupError: unknown) {
      reportDashboardHotDisposalFailure(cleanupError);
    }
    throw error;
  }
}

function reportDashboardHotDisposalFailure(error: unknown): void {
  const safeError = toSafeError(error, { clientLabel: "Station dashboard" });
  process.stderr.write(`[station] ${safeError.code}: ${safeError.message}\n`);
}

if (import.meta.main) {
  await runDashboardMain();
}

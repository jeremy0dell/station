import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { StationHostConvergenceCommand } from "@station/contracts";
import { createStationHostClient } from "@station/host";
import { componentLogPath, createJsonlLogger, toSafeError } from "@station/observability";
import { stationBuildInfo } from "@station/runtime";
import { convergeStationHost } from "@station/terminal";
import { Profiler } from "react";
import { loadStationConfig } from "./config/stationConfig.js";
import {
  loadStationTuiConfig,
  resolveSessionCreatePolicies,
  sessionCreatePolicyForTerminal,
} from "./config/tuiConfig.js";
import { createNodeFolderService } from "./folderNavigation/nodeFolderService.js";
import { createOpenTuiSelectionCopyHandler } from "./copy/openTuiSelection.js";
import { createRuntimeClipboardEffects } from "./copy/runtimeClipboard.js";
import { devRenderProfilePath } from "./host/devPaths.js";
import { beginHotDisposal, waitForHotDisposal } from "./hmr/hotDisposalBarrier.js";
import {
  getOrCreateStationHotRuntime,
  STATION_HOT_RUNTIME_VERSION,
  stationHotSlots,
  type StationHotRenderer,
  type StationHotSlots,
} from "./hmr/stationHotRuntime.js";
import { invokeCleanup, settleCleanupSteps } from "./lifecycle/cleanup.js";
import {
  createNativeProcessLifecycle,
  type NativeProcessLifecycle,
} from "./lifecycle/nativeProcessLifecycle.js";
import { installLiveHostTtyDimensions } from "./liveHostTtyDimensions.js";
import {
  createStationNativePlacementEndpoint,
  type StationNativePlacementEndpoint,
} from "./nativePlacementEndpoint.js";
import { createRenderProfiler, readRenderProfileEnabled } from "./profiling/renderProfiler.js";
import {
  acquireStationTtyOwnership,
  currentStdinMatchesStationTty,
  stationTtyOwnershipUnavailableError,
  type StationTtyOwnership,
} from "./singleInstance.js";
import { createStation, StationApp } from "./app/createStation.js";
import { STATION_KEYBOARD_PROTOCOL } from "./input/keyboardProtocol.js";
import { buildBootRestorePlan } from "./state/layout/bootRestore.js";
import type { LayoutRestorePlan } from "./state/layout/restoreLayout.js";
import { readLayoutSnapshotSync } from "./state/layout/layoutPersistence.js";
import { applyRestoreSeeds, planLayoutRestoreColdShells } from "./state/layout/restoreLayout.js";
import { savedCwdExists } from "./state/layout/savedCwdExists.js";
import { wireTerminalDiagnostics } from "./terminal/diagnostics.js";
import { resolveAuxShellPlacement } from "./terminal/pty/auxShellPlacement.js";
import {
  createHostAttachedTerminal,
  type HostAttachedTerminalOptions,
} from "./terminal/pty/hostAttachedTerminal.js";
import { createStationHostManagedTerminalAttacher } from "./terminal/pty/managedTerminalAttacher.js";
import { playStationAttentionSound } from "./attention/attentionSound.js";
import { createStationClient } from "./client/createStationClient.js";
import { openExternalUrl } from "./openUrl.js";
import { listLiveHostPtys } from "./host/listLiveHostPtys.js";
import { resolveStationHostSocketPath } from "./host/stationHostSocketPath.js";
import { resolveStationLayoutPath } from "./state/layout/stationLayoutPath.js";
import { nativeStationTheme, StationThemeProvider } from "./theme/index.js";
import type { PreparedPtyRuntime } from "./bin/packagedAssets.js";
import {
  createUiLifecycleWitness,
  type UiLifecycleWitness,
} from "./diagnostics/uiLifecycle.js";
import { resolveUiRunContext } from "./diagnostics/uiRunContext.js";
import {
  observeUiSurfaceLifecycle,
  selectUiLifecycleSurface,
} from "./diagnostics/uiSurfaceLifecycle.js";

export type RunStationMainOptions = {
  /** Compiled entrypoint seam: prepare embedded PTY assets after state-dir resolution. */
  preparePtyRuntime?: (stateDir: string) => Promise<PreparedPtyRuntime>;
};

// A 1/0/true/false flag in the readSourceName style: opt in to auto-closing
// the STATION overlay when a `[+sh]` shell pane opens. Unset/empty keeps the
// overlay up (the default).
function readShellAutoCloseOverlay(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  throw new Error(
    `Unsupported STATION_SHELL_AUTOCLOSE=${value}. Expected "1"/"true" or "0"/"false".`,
  );
}

function stationHostSuccessorCommand(
  env: Readonly<Record<string, string | undefined>>,
): readonly [string, ...string[]] {
  if (stationBuildInfo().compiled) {
    return [process.execPath, "__station-host"];
  }
  const configuredEntry = env.STATION_HOST_ENTRY;
  const hostEntry =
    configuredEntry !== undefined && configuredEntry.length > 0
      ? configuredEntry
      : fileURLToPath(new URL("./host/hostMain.ts", import.meta.url));
  return [env.STATION_BUN ?? "bun", hostEntry];
}

/**
 * Callable native OpenTUI process entry and semantic lifecycle witness boundary.
 * It acquires TTY ownership before other startup work, binds one validated run
 * context into Host terminal factories, owns native signal/lifecycle evidence,
 * and releases final TTY ownership only after renderer shutdown.
 */
export async function runStationMain(options: RunStationMainOptions = {}): Promise<void> {
  const ownershipResult = await acquireStationTtyOwnership();
  if (ownershipResult.kind === "refused") {
    writeStartupError(ownershipResult.error);
    process.exitCode = 1;
    return;
  }
  const ttyOwnership = ownershipResult.kind === "owned" ? ownershipResult.ownership : undefined;
  let uiLifecycle: UiLifecycleWitness | undefined;
  try {
    const started = await startStationMain(options, ttyOwnership, (created) => {
      uiLifecycle = created;
    });
    if (!started) {
      ttyOwnership?.release();
    }
  } catch (error) {
    if (uiLifecycle !== undefined) {
      await uiLifecycle.fatalShutdown(error);
    }
    ttyOwnership?.release();
    throw error;
  }
}

async function startStationMain(
  options: RunStationMainOptions,
  ttyOwnership: StationTtyOwnership | undefined,
  onLifecycleCreated: (lifecycle: UiLifecycleWitness) => void,
): Promise<boolean> {
  const env = process.env;
  const stationGlobalSlots = stationHotSlots();
  // A prior renderer releases process-global stdin synchronously before dashboard settlement is awaited.
  await invokeCleanup(() => stationGlobalSlots.__stationHotRenderer?.destroy()).catch(
    reportNativeHotDisposalFailure,
  );
  await waitForHotDisposal(stationGlobalSlots);

  const stationClient = createStationClient(env, {
    onAttentionNeeded: () => {
      playStationAttentionSound();
    },
  });
  // Started now so the observer subscribe + snapshot resync overlaps the boot
  // phases below and the first painted frame is already populated. createStation's
  // lifecycle calls start() again — a guarded no-op.
  stationClient.start();

  const stationConfigLoading = loadStationConfig({ env });
  const configsLoading = Promise.all([stationConfigLoading, loadStationTuiConfig({ env })]);

  const uiContext = resolveUiRunContext({
    env,
    slots: stationGlobalSlots,
    clientKind: "native_renderer",
  });

  // Resolve the layout snapshot path defensively: a missing HOME/XDG just disables
  // persistence (warn, keep running) rather than crashing the UI at boot.
  let layoutPath: string | undefined;
  try {
    layoutPath = resolveStationLayoutPath(env);
  } catch (error) {
    console.error(`[station] layout persistence disabled: ${(error as Error).message}`);
  }
  // Cold-boot ONLY: load + seat the persisted layout. HMR reuses the live runtime
  // (its store + PTYs already hold the current layout), so re-seating a disk
  // snapshot would clobber edits made since the last save — gate on a clean boot.
  const isColdBoot =
    stationGlobalSlots.__stationHotRuntime?.version !== STATION_HOT_RUNTIME_VERSION;
  const restoredLayout =
    isColdBoot && layoutPath !== undefined ? readLayoutSnapshotSync(layoutPath) : undefined;

  // Station-host socket: aux shells spawn into it (and panes warm-reattach to it)
  // when it is up. A resolution failure (no HOME/XDG) just disables host
  // integration — aux shells stay local and the boot is always cold.
  let hostSocketPath: string | undefined;
  try {
    hostSocketPath = resolveStationHostSocketPath(env);
  } catch (error) {
    console.error(`[station] persistent shells disabled: ${(error as Error).message}`);
  }

  const createHostClient = (socketPath: string) =>
    createStationHostClient({ socketPath, uiContext });
  const convergeExactHost = async (command: StationHostConvergenceCommand) => {
    const stationConfig = await stationConfigLoading;
    return convergeStationHost({
      command,
      targetBuild: command.targetBuild,
      socketPath: command.socketPath,
      stateDir: stationConfig.stateDir,
      hostCommand: stationHostSuccessorCommand(env),
    });
  };
  const listHostPtys = (socketPath: string) =>
    listLiveHostPtys(socketPath, {
      env,
      createClient: createHostClient,
      convergeExactHost,
    });
  const createHostTerminal = (terminalOptions: HostAttachedTerminalOptions) =>
    createHostAttachedTerminal({ ...terminalOptions, uiContext });
  const auxShellPlacement =
    hostSocketPath === undefined
      ? undefined
      : resolveAuxShellPlacement(hostSocketPath, createHostClient);
  const managedTerminalAttacher =
    hostSocketPath === undefined
      ? undefined
      : createStationHostManagedTerminalAttacher(hostSocketPath, {
          listHost: listHostPtys,
          createTerminal: createHostTerminal,
        });

  // Compatibility errors must escape before cold restore can drop warm panes or
  // layout persistence can rewrite the saved session.
  let liveHostPtys: Awaited<ReturnType<typeof listLiveHostPtys>>;
  try {
    liveHostPtys =
      hostSocketPath === undefined
        ? undefined
        : await listHostPtys(hostSocketPath);
  } catch (error) {
    const safeError = toSafeError(error, {
      tag: "TerminalProviderError",
      code: "HOST_VERSION_INCOMPATIBLE",
      message: "Station host cannot be safely reused by this Station build.",
      provider: "native",
    });
    writeStartupError(safeError);
    await stationClient.stop();
    process.exitCode = 1;
    return false;
  }

  // Warm-reattach live host PTYs when a host is up, else cold-respawn fresh shells.
  let restorePlanLoading: LayoutRestorePlan | Promise<LayoutRestorePlan> | undefined;
  if (restoredLayout !== undefined) {
    if (hostSocketPath === undefined) {
      restorePlanLoading = planLayoutRestoreColdShells(restoredLayout, {
        cwdExists: savedCwdExists,
      });
    } else {
      const socket = hostSocketPath;
      restorePlanLoading = buildBootRestorePlan(restoredLayout, {
        cwdExists: savedCwdExists,
        listHost: async () => liveHostPtys,
        makeHostTerminal: (entry) => (options) =>
          createHostTerminal({
            hostSocketPath: socket,
            ptyRef: entry,
            size: { cols: options.size?.cols ?? 80, rows: options.size?.rows ?? 24 },
            // Reattaching an aux PTY keeps Station's ownership, so closing the pane
            // closes the PTY; an agent reattach stays observer-owned (detach only).
            ...(entry.kind === "aux" ? { owned: true } : {}),
          }),
        resolveAuxShellPlacement: resolveAuxShellPlacement(socket, createHostClient),
      });
    }
  }

  const [[stationConfig, tuiConfig], restorePlan] = await Promise.all([
    configsLoading,
    restorePlanLoading,
  ]);
  // Warnings print before the renderer takes the screen so they stay readable on
  // the normal terminal. A broken/absent file degrades to defaults.
  if (stationConfig.warning !== undefined) {
    console.error(`[station] ${stationConfig.warning}`);
  }
  if (tuiConfig.warning !== undefined) {
    console.error(`[station] ${tuiConfig.warning}`);
  }
  const tuiLogger = createJsonlLogger({
    component: "tui",
    path: componentLogPath(stationConfig.stateDir, "tui"),
  });
  const uiLifecycle = createUiLifecycleWitness({ logger: tuiLogger, context: uiContext });
  onLifecycleCreated(uiLifecycle);
  await uiLifecycle.started();
  const ptyRuntime = await options.preparePtyRuntime?.(stationConfig.stateDir);

  // Corruption telemetry sink: detectors count regardless; with this wired they
  // also log to logs/tui.jsonl and write pane evidence dumps under
  // diagnostics/panes/.
  wireTerminalDiagnostics({
    logger: tuiLogger,
    dumpDir: join(stationConfig.stateDir, "diagnostics", "panes"),
  });

  // HMR recreates renderer, input handlers, and observer subscriptions, but keeps
  // coordination state plus live PTYs so a code edit returns to the active session
  // instead of booting a fresh pane-main shell. A normal station.exit still calls
  // station.disposeForShutdown() and tears these down.
  const stationRuntime = getOrCreateStationHotRuntime(
    stationGlobalSlots,
    stationConfig.config,
    restorePlan?.workspace,
  );
  stationRuntime.registry.updateTerminalTheme(nativeStationTheme.terminal);
  const { store } = stationRuntime;
  // Seed each restored pane's spawn cwd / host placement into the registry BEFORE the
  // reconciler runs its no-option ensure (which would otherwise capture
  // no cwd), so a freshly respawned shell reopens in its saved directory and a
  // reattached pane binds to its live host PTY. A warm agent's identity already rides
  // on its restored record (seated by the plan), so its exit still reports.
  if (restorePlan !== undefined) {
    applyRestoreSeeds(stationRuntime.registry, restorePlan.seeds);
  }

  const clipboardEffects = createRuntimeClipboardEffects({
    env,
    platform: process.platform,
    // OSC 52 goes to the outer terminal, not the PTY; a short escape the terminal
    // consumes without disturbing OpenTUI's rendering.
    writeToHost: (sequence) => process.stdout.write(sequence),
  });

  let rendererForInput: CliRenderer | undefined;
  let rootForShutdown: { unmount(): void } | undefined;
  let stopSurfaceObservation: (() => void) | undefined;
  let processLifecycle: NativeProcessLifecycle | undefined;
  const station = createStation({
    store,
    stationClient,
    folderService: createNodeFolderService(),
    registry: stationRuntime.registry,
    scrollOnOutput: stationConfig.config.scroll_on_output,
    scrollbackLines: stationConfig.config.scrollback_lines,
    overlayWidthPercent: stationConfig.config.overlay_width_percent,
    overlayHeightPercent: stationConfig.config.overlay_height_percent,
    automations: stationConfig.config.automations,
    clipboardEffects,
    openExternalUrl,
    ...(tuiConfig.config === undefined ? {} : { tuiConfig: tuiConfig.config }),
    ...(tuiConfig.configPath === undefined ? {} : { tuiConfigPath: tuiConfig.configPath }),
    createdSessionPolicy: sessionCreatePolicyForTerminal(
      resolveSessionCreatePolicies(tuiConfig.config?.sessionCreate),
      "native",
    ),
    shellAutoCloseOverlay: readShellAutoCloseOverlay(env.STATION_SHELL_AUTOCLOSE),
    ...(auxShellPlacement === undefined ? {} : { resolveAuxShellPlacement: auxShellPlacement }),
    ...(managedTerminalAttacher === undefined ? {} : { managedTerminalAttacher }),
    ...(layoutPath === undefined ? {} : { layout: { path: layoutPath } }),
    ...(ptyRuntime === undefined ? {} : { createTerminal: ptyRuntime.createTerminal }),
    shutdown: () => void processLifecycle?.request("ctrl_q"),
  });

  if (ttyOwnership !== undefined && !currentStdinMatchesStationTty(ttyOwnership.identity)) {
    const error = stationTtyOwnershipUnavailableError();
    writeStartupError(error);
    await uiLifecycle.fatalShutdown(error);
    await station.disposeForShutdown();
    ptyRuntime?.dispose();
    await stationClient.stop();
    await uiLifecycle.flush();
    process.exitCode = 1;
    return false;
  }
  let nativePlacementEndpoint: StationNativePlacementEndpoint | undefined =
    stationRuntime.nativePlacementEndpoint;
  if (nativePlacementEndpoint === undefined) {
    try {
      nativePlacementEndpoint = await createStationNativePlacementEndpoint({
        stateDir: stationConfig.stateDir,
        uiRunId: uiContext.uiRunId,
      });
      stationRuntime.nativePlacementEndpoint = nativePlacementEndpoint;
    } catch (error) {
      await tuiLogger
        .warn("Native session placement is unavailable; Station startup will continue.", {
          error: toSafeError(error, {
            tag: "TerminalProviderError",
            code: "TERMINAL_PLACEMENT_EVIDENCE_UNAVAILABLE",
            message: "Station could not create its native placement endpoint.",
            provider: "native",
          }),
        })
        .catch(() => undefined);
    }
  }
  const nativePlacementGeneration = nativePlacementEndpoint?.attach({
    store,
    registry: stationRuntime.registry,
    createHostTerminal,
  });
  processLifecycle = createNativeProcessLifecycle({
    stopSurfaceObservation: () => stopSurfaceObservation?.(),
    cleanupSteps: [
      ...(nativePlacementEndpoint === undefined
        ? []
        : [
            async () => {
              await nativePlacementEndpoint.close();
              if (stationRuntime.nativePlacementEndpoint === nativePlacementEndpoint) {
                delete stationRuntime.nativePlacementEndpoint;
              }
            },
          ]),
      () => station.disposeForShutdown(),
      () => rootForShutdown?.unmount(),
      () => rendererForInput?.destroy(),
      () => ptyRuntime?.dispose(),
    ],
    lifecycle: uiLifecycle,
    releaseTty: () => ttyOwnership?.release(),
  });
  ttyOwnership?.setTakeoverHandler(() => void processLifecycle?.request("tty_takeover"));

  const copySelectedText = createOpenTuiSelectionCopyHandler(
    () => rendererForInput,
    clipboardEffects,
  );
  installLiveHostTtyDimensions();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    maxFps: 1_500,
    exitSignals: [
      "SIGINT",
      "SIGTERM",
      "SIGQUIT",
      "SIGABRT",
      "SIGBREAK",
      "SIGPIPE",
      "SIGBUS",
    ],
    prependInputHandlers: [copySelectedText, station.stationInput.handleSequence],
    useKittyKeyboard: STATION_KEYBOARD_PROTOCOL,
  });
  rendererForInput = renderer;
  stationGlobalSlots.__stationHotRenderer = renderer;
  // OpenTUI routes paste events around the sequence handlers above, so the
  // pane would never see a paste without this explicit forward.
  renderer.keyInput.on("paste", (event) => {
    station.stationInput.handlePaste(event);
  });
  const root = createRoot(renderer);
  rootForShutdown = root;

  // Opt-in dev profiling (STATION_PROFILE=1). Off by default: the tree renders
  // bare, byte-for-byte the production path.
  const onRenderProfile = readRenderProfileEnabled(env.STATION_PROFILE)
    ? createRenderProfiler(devRenderProfilePath())
    : undefined;
  station.start();
  const stationApp = (
    <StationThemeProvider theme={nativeStationTheme}>
      <StationApp {...station.viewProps} />
    </StationThemeProvider>
  );
  root.render(
    onRenderProfile ? (
      <Profiler id="station" onRender={onRenderProfile}>
        {stationApp}
      </Profiler>
    ) : (
      stationApp
    ),
  );

  await uiLifecycle.ready(selectUiLifecycleSurface(store.getState()));
  stopSurfaceObservation = observeUiSurfaceLifecycle({ store, witness: uiLifecycle });
  processLifecycle.install();

  if (import.meta.hot) {
    import.meta.hot.accept();
    import.meta.hot.dispose(() => {
      beginHotDisposal(
        stationGlobalSlots,
        () =>
          settleCleanupSteps(
            [
              () => processLifecycle?.dispose(),
              () => {
                if (
                  nativePlacementEndpoint !== undefined &&
                  nativePlacementGeneration !== undefined
                ) {
                  nativePlacementEndpoint.suspend(nativePlacementGeneration);
                }
              },
              // Renderer and stdin release cannot wait for asynchronous dashboard settlement.
              () => stopSurfaceObservation?.(),
              () => root.unmount(),
              () => renderer.destroy(),
              () => releaseHotRendererIfCurrent(stationGlobalSlots, renderer),
              () => station.disposeForHotReload(),
            ],
            "Native Station HMR cleanup failed.",
          ),
        (error) => {
          void uiLifecycle.fatal(error).catch(() => {
            // HMR replacement ordering cannot depend on diagnostic persistence.
          });
        },
      );
    });
  }
  return true;
}

function releaseHotRendererIfCurrent(
  slots: StationHotSlots,
  renderer: StationHotRenderer,
): void {
  if (slots.__stationHotRenderer === renderer) {
    delete slots.__stationHotRenderer;
  }
}

function reportNativeHotDisposalFailure(error: unknown): void {
  writeStartupError(
    toSafeError(error, {
      tag: "TuiLifecycleError",
      code: "TUI_HMR_CLEANUP_FAILED",
      message: "Native Station hot-reload cleanup failed.",
    }),
  );
}

function writeStartupError(error: { code: string; message: string; hint?: string }): void {
  process.stderr.write(
    `[station] ${error.code}: ${error.message}${error.hint === undefined ? "" : `\n${error.hint}`}\n`,
  );
}

if (import.meta.main) {
  await runStationMain();
}

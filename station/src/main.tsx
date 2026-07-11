import { spawn } from "node:child_process";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { componentLogPath, createJsonlLogger, toSafeError } from "@station/observability";
import { Profiler } from "react";
import { loadStationConfig } from "./config/stationConfig.js";
import { loadStationTuiConfig } from "./config/tuiConfig.js";
import {
  type ClipboardCommand,
  createClipboardEffects,
} from "./copy/clipboard.js";
import { createInternalClipboard } from "./copy/internalClipboard.js";
import { devRenderProfilePath } from "./host/devPaths.js";
import {
  getOrCreateStationHotRuntime,
  STATION_HOT_RUNTIME_VERSION,
  stationHotSlots,
} from "./hmr/stationHotRuntime.js";
import { createRenderProfiler, readRenderProfileEnabled } from "./profiling/renderProfiler.js";
import { terminateRivalStationUIs } from "./singleInstance.js";
import { createStation, StationApp } from "./app/createStation.js";
import { STATION_KEYBOARD_PROTOCOL } from "./input/keyboardProtocol.js";
import { buildBootRestorePlan } from "./state/layout/bootRestore.js";
import type { LayoutRestorePlan } from "./state/layout/restoreLayout.js";
import { readLayoutSnapshotSync } from "./state/layout/layoutPersistence.js";
import { applyRestoreSeeds, planLayoutRestoreColdShells } from "./state/layout/restoreLayout.js";
import { savedCwdExists } from "./state/layout/savedCwdExists.js";
import { wireTerminalDiagnostics } from "./terminal/diagnostics.js";
import { resolveAuxShellPlacement } from "./terminal/pty/auxShellPlacement.js";
import { createHostAttachedTerminal } from "./terminal/pty/hostAttachedTerminal.js";
import { playStationAttentionSound } from "./sources/attentionSound.js";
import { createStationClient } from "./sources/createStationClient.js";
import { resolveOpenUrlCommand } from "./openUrl.js";
import { listLiveHostPtys } from "./sources/listLiveHostPtys.js";
import { resolveStationHostSocketPath } from "./sources/stationHostSocketPath.js";
import { resolveStationLayoutPath } from "./sources/stationLayoutPath.js";
import type { PreparedPtyRuntime } from "./bin/packagedAssets.js";

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

// Best-effort: a missing clipboard binary (the `error` event) or a write
// failure is swallowed — the OSC 52 / internal sinks still carry the yank.
function spawnClipboard(command: ClipboardCommand, text: string): void {
  try {
    const child = spawn(command.command, [...command.args], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    // Guard the stdin stream too: a child that exits before draining makes the
    // write below emit an async EPIPE that the sync try/catch can't catch.
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  } catch {
    // ignore: clipboard CLI not present
  }
}

function openExternalUrl(rawUrl: string): void {
  const command = resolveOpenUrlCommand(process.platform, rawUrl);
  if (command === undefined) {
    return;
  }
  try {
    const child = spawn(command.command, command.args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore: no platform opener available
  }
}

/**
 * Callable native OpenTUI process entry; standalone and HMR module startup invoke it once.
 * Compiled startup may inject packaged PTY preparation without changing source defaults.
 */
export async function runStationMain(options: RunStationMainOptions = {}): Promise<void> {
  const env = process.env;
  const stationClient = createStationClient(env, {
    onAttentionNeeded: () => {
      playStationAttentionSound();
    },
  });
  // Started now so the observer subscribe + snapshot resync overlaps the boot
  // phases below and the first painted frame is already populated. createStation's
  // lifecycle calls start() again — a guarded no-op.
  stationClient.start();

  const configsLoading = Promise.all([loadStationConfig({ env }), loadStationTuiConfig({ env })]);

  // Kicked after configsLoading so its synchronous ps calls don't delay the config
  // reads; awaited before raw mode below.
  const rivalsReaped = terminateRivalStationUIs();

  const stationGlobalSlots = stationHotSlots();

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

  // Compatibility errors must escape before cold restore can drop warm panes or
  // layout persistence can rewrite the saved session.
  let liveHostPtys: Awaited<ReturnType<typeof listLiveHostPtys>>;
  try {
    liveHostPtys =
      hostSocketPath === undefined ? undefined : await listLiveHostPtys(hostSocketPath);
  } catch (error) {
    const safeError = toSafeError(error, {
      tag: "TerminalProviderError",
      code: "HOST_VERSION_INCOMPATIBLE",
      message: "Station host cannot be safely reused by this Station build.",
      provider: "native",
    });
    process.stderr.write(
      `[station] ${safeError.code}: ${safeError.message}${safeError.hint === undefined ? "" : `\n${safeError.hint}`}\n`,
    );
    await stationClient.stop();
    process.exitCode = 1;
    return;
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
          createHostAttachedTerminal({
            hostSocketPath: socket,
            ptyId: entry.ptyId,
            size: { cols: options.size?.cols ?? 80, rows: options.size?.rows ?? 24 },
            // Reattaching an aux PTY keeps Station's ownership, so closing the pane
            // closes the PTY; an agent reattach stays observer-owned (detach only).
            ...(entry.kind === "aux" ? { owned: true } : {}),
          }),
        resolveAuxShellPlacement: resolveAuxShellPlacement(socket),
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
  const ptyRuntime = await options.preparePtyRuntime?.(stationConfig.stateDir);

  // Corruption telemetry sink: detectors count regardless; with this wired they
  // also log to logs/tui.jsonl and write pane evidence dumps under
  // diagnostics/panes/.
  wireTerminalDiagnostics({
    logger: createJsonlLogger({
      component: "tui",
      path: componentLogPath(stationConfig.stateDir, "tui"),
    }),
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
  const { store } = stationRuntime;
  // Seed each restored pane's spawn cwd / host placement into the registry BEFORE the
  // reconciler runs its no-option ensure (which would otherwise capture
  // no cwd), so a freshly respawned shell reopens in its saved directory and a
  // reattached pane binds to its live host PTY. A warm agent's identity already rides
  // on its restored record (seated by the plan), so its exit still reports.
  if (restorePlan !== undefined) {
    applyRestoreSeeds(stationRuntime.registry, restorePlan.seeds);
  }

  // Internal buffer + OSC 52 (to the host) + a spawned platform clipboard CLI.
  const internalClipboard = createInternalClipboard();
  const clipboardEffects = createClipboardEffects({
    internal: internalClipboard,
    env: process.env,
    platform: process.platform,
    // OSC 52 goes to the outer terminal, not the PTY; a short escape the terminal
    // consumes without disturbing OpenTUI's rendering.
    writeToHost: (sequence) => process.stdout.write(sequence),
    spawnClipboard: (command, text) => spawnClipboard(command, text),
  });

  const station = createStation({
    store,
    stationClient,
    registry: stationRuntime.registry,
    scrollOnOutput: stationConfig.config.scroll_on_output,
    overlayWidthPercent: stationConfig.config.overlay_width_percent,
    overlayHeightPercent: stationConfig.config.overlay_height_percent,
    automations: stationConfig.config.automations,
    clipboardEffects,
    openExternalUrl,
    ...(tuiConfig.config === undefined ? {} : { tuiConfig: tuiConfig.config }),
    ...(tuiConfig.configPath === undefined ? {} : { tuiConfigPath: tuiConfig.configPath }),
    shellAutoCloseOverlay: readShellAutoCloseOverlay(env.STATION_SHELL_AUTOCLOSE),
    ...(hostSocketPath === undefined ? {} : { hostSocketPath }),
    ...(layoutPath === undefined ? {} : { layout: { path: layoutPath } }),
    ...(ptyRuntime === undefined ? {} : { createTerminal: ptyRuntime.createTerminal }),
    shutdown: () => {
      rootForShutdown?.unmount();
      rendererForInput?.destroy();
      ptyRuntime?.dispose();
      process.exit(0);
    },
  });
  let rendererForInput: { destroy(): void } | undefined;
  let rootForShutdown: { unmount(): void } | undefined;

  // Under `bun --hot`, OpenTUI's stdin ownership is a process-global that outlives
  // the reload and our dispose() may not run before the new createCliRenderer()
  // below — which would then throw "stdin is already used". Destroy the prior
  // renderer first (idempotent, frees stdin synchronously); stash on globalThis
  // since module locals reset.
  stationGlobalSlots.__stationHotRenderer?.destroy();

  // No rival stdin reader may survive past this line: createCliRenderer claims
  // raw mode next, and two readers on one tty tear multi-byte key sequences
  // apart (Shift+Enter and friends). See singleInstance.ts.
  await rivalsReaped;

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    prependInputHandlers: [station.stationInput.handleSequence],
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
  root.render(
    onRenderProfile ? (
      <Profiler id="station" onRender={onRenderProfile}>
        <StationApp {...station.viewProps} />
      </Profiler>
    ) : (
      <StationApp {...station.viewProps} />
    ),
  );

  if (import.meta.hot) {
    import.meta.hot.accept();
    import.meta.hot.dispose(() => {
      station.disposeForHotReload();
      root.unmount();
      renderer.destroy();
      // Don't clobber a newer reload's stashed renderer.
      if (stationGlobalSlots.__stationHotRenderer === renderer) {
        stationGlobalSlots.__stationHotRenderer = undefined;
      }
    });
  }
}

if (import.meta.main) {
  await runStationMain();
}

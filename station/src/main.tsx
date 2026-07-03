import { spawn } from "node:child_process";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
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
import { resolveAuxShellPlacement } from "./terminal/pty/auxShellPlacement.js";
import { createHostAttachedTerminal } from "./terminal/pty/hostAttachedTerminal.js";
import { playStationAttentionSound } from "./sources/attentionSound.js";
import { createStationClient } from "./sources/createStationClient.js";
import { resolveOpenUrlCommand } from "./openUrl.js";
import { listLiveHostPtys } from "./sources/listLiveHostPtys.js";
import { resolveStationHostSocketPath } from "./sources/stationHostSocketPath.js";
import { resolveStationLayoutPath } from "./sources/stationLayoutPath.js";

declare const Bun: {
  env: Record<string, string | undefined>;
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

const stationClient = createStationClient(Bun.env, {
  onAttentionNeeded: () => {
    playStationAttentionSound();
  },
});
// Loaded before the renderer takes the screen so a config warning is still
// readable on the normal terminal. A broken/absent file degrades to defaults.
const stationConfig = await loadStationConfig({ env: Bun.env });
if (stationConfig.warning !== undefined) {
  console.error(`[station] ${stationConfig.warning}`);
}
const tuiConfig = await loadStationTuiConfig({ env: Bun.env });
if (tuiConfig.warning !== undefined) {
  console.error(`[station] ${tuiConfig.warning}`);
}

const stationGlobalSlots = stationHotSlots();

// Resolve the layout snapshot path defensively: a missing HOME/XDG just disables
// persistence (warn, keep running) rather than crashing the UI at boot.
let layoutPath: string | undefined;
try {
  layoutPath = resolveStationLayoutPath(Bun.env);
} catch (error) {
  console.error(`[station] layout persistence disabled: ${(error as Error).message}`);
}
// Cold-boot ONLY: load + seat the persisted layout. HMR reuses the live runtime
// (its store + PTYs already hold the current layout), so re-seating a disk
// snapshot would clobber edits made since the last save — gate on a clean boot.
const isColdBoot = stationGlobalSlots.__stationHotRuntime?.version !== STATION_HOT_RUNTIME_VERSION;
const restoredLayout =
  isColdBoot && layoutPath !== undefined ? readLayoutSnapshotSync(layoutPath) : undefined;

// Station-host socket: aux shells spawn into it (and panes warm-reattach to it)
// when it is up. A resolution failure (no HOME/XDG) just disables host
// integration — aux shells stay local and the boot is always cold.
let hostSocketPath: string | undefined;
try {
  hostSocketPath = resolveStationHostSocketPath(Bun.env);
} catch (error) {
  console.error(`[station] persistent shells disabled: ${(error as Error).message}`);
}

// Warm-reattach live host PTYs when a host is up, else cold-respawn fresh shells.
let restorePlan: LayoutRestorePlan | undefined;
if (restoredLayout !== undefined) {
  if (hostSocketPath === undefined) {
    restorePlan = planLayoutRestoreColdShells(restoredLayout, { cwdExists: savedCwdExists });
  } else {
    const socket = hostSocketPath;
    restorePlan = await buildBootRestorePlan(restoredLayout, {
      cwdExists: savedCwdExists,
      listHost: () => listLiveHostPtys(socket),
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
  automations: stationConfig.config.automations,
  clipboardEffects,
  openExternalUrl,
  ...(tuiConfig.config === undefined ? {} : { tuiConfig: tuiConfig.config }),
  shellAutoCloseOverlay: readShellAutoCloseOverlay(Bun.env.STATION_SHELL_AUTOCLOSE),
  ...(hostSocketPath === undefined ? {} : { hostSocketPath }),
  ...(layoutPath === undefined ? {} : { layout: { path: layoutPath } }),
  shutdown: () => {
    rootForShutdown?.unmount();
    rendererForInput?.destroy();
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

// Reap any other Station UI still attached to this terminal before we put stdin
// into raw mode. Two readers on one tty tear multi-byte key sequences apart
// (Shift+Enter and friends), so this enforces one UI per terminal. See
// singleInstance.ts.
terminateRivalStationUIs();

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
const onRenderProfile = readRenderProfileEnabled(Bun.env.STATION_PROFILE)
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

import type { AuxShellPlacement } from "../terminal/pty/auxShellPlacement.js";
import type { PtyRegistry } from "../terminal/registry/ptyRegistry.js";
import type { Automation } from "../config/stationConfig.js";
import type { StoreApi } from "zustand/vanilla";
import type { StationStore } from "../state/store.js";
import {
  MAIN_PANE_ID,
  STATION_OVERLAY_ID,
  type PaneId,
  type PaneRole,
  type PaneSplitDirection,
} from "../state/types.js";
import { sanitizePastedText } from "../station/input/sequenceToTuiKey.js";
import { dispatchStationKey } from "../station/input/stationActions.js";
import type { ObserverService } from "@station/client";
import type { ProviderId } from "@station/contracts";
import type { TuiStore } from "@station/dashboard-core";
import {
  routeKey,
  routeMouse,
  routePaste,
  type MouseBindings,
  type MouseTargetRef,
  type RouteOutcome,
  type StationCommandId,
} from "./router.js";
import type { KeymapStack } from "./keymaps.js";
import { createStationKeymap, createStationMouseBindings } from "./stationBindings.js";
import type { StationMouseEvent } from "./mouse.js";
import { focusedPaneAcceptsModifiedEnter } from "./modifiedEnterPolicy.js";
import {
  normalizeSequence,
  providerSupportsModifiedEnterSoftNewline,
  type NormalizedSequence,
} from "./sequenceNormalize.js";
import { executeOutcome } from "./executeOutcome.js";
import { createPaneEffects } from "./paneEffects.js";
import { createManagedLaunch, type ManagedLaunchTarget } from "./managedLaunch.js";

// Re-exported so callers (apps + tests) keep importing them from this module.
export { executeOutcome, normalizeSequence };
export { nextSplitSeqFromPanes } from "./paneEffects.js";
export type { NormalizedSequence, ManagedLaunchTarget };

/**
 * What an open-pane effect spawns: the cwd plus, for a primary agent, the
 * harness `command`/`args`, the pane `role`, and the `worktreeId` it belongs
 * to. The `[+sh]` shell passes only `cwd` (role defaults to shell), so its
 * spawn is unchanged.
 */
export type OpenPaneSpawn = {
  cwd: string;
  command?: string;
  args?: readonly string[];
  role?: PaneRole;
  worktreeId?: string;
};

export type StationInputEffects = {
  store: StationStore;
  stationViewStore?: StoreApi<TuiStore>;
  /** Configured automations, surfaced in the pane context menu. */
  automations: readonly Automation[];
  runCommand(commandId: StationCommandId): void;
  writeToTerminal(paneId: PaneId, bytes: string): boolean;
  pasteToTerminal(paneId: PaneId, text: string): boolean;
  /**
   * Apply a wheel tick to a pane: scroll its scrollback in the normal buffer,
   * or forward the wheel to the app (SGR wheel / arrow keys) when it owns the
   * screen. Returns whether anything was consumed.
   */
  scrollTerminal(paneId: PaneId, direction: "up" | "down"): boolean;
  /** Open-or-focus a pane, spawning its process per `spawn` on first creation. */
  openPane(paneId: PaneId, spawn: OpenPaneSpawn): void;
  /**
   * Split the anchor pane: create a fresh ad-hoc shell pane whose split metadata
   * anchors it to `anchorPaneId`, making it active/focused (overlay-aware). The
   * minted id is intentionally non-deterministic — a split pane has no
   * worktree/project identity to derive a stable id from.
   */
  splitPane(anchorPaneId: PaneId, direction: PaneSplitDirection): void;
  /**
   * Run a configured automation anchored on `anchorPaneId`: for each step, split
   * a fresh shell pane in the anchor's worktree directory and send the step's
   * command — executed (trailing Enter) or written (typed, no Enter) per the
   * step. No-op for an unknown or disabled automation id.
   */
  runAutomation(automationId: string, anchorPaneId: PaneId): void;
  /**
   * Close removes the pane record after process teardown: aux/local shells die,
   * attached agents only detach because observer owns their lifecycle.
   */
  closePane(paneId: PaneId): void;
  /**
   * Managed launches are fire-and-forget so input stays consumed while observer
   * preparation and local spawn finish; failures surface as STATION toasts.
   */
  launchPrimaryAgent(paneId: PaneId, target: ManagedLaunchTarget): void;
  /**
   * Create a new worktree and host its primary agent in a Station pane (the New
   * Session wizard's submit). Fire-and-forget like launchPrimaryAgent: it closes
   * the wizard, creates the worktree, then runs the same managed launch a row
   * click uses; failures surface as a STATION toast.
   */
  launchHostedNewSession(target: { projectId: string; branch: string; harness: ProviderId }): void;
  openExternalUrl(url: string): void;
};

function splitActivePane(
  store: StationStore,
  splitPane: (anchorPaneId: PaneId, direction: PaneSplitDirection) => void,
  direction: PaneSplitDirection,
): void {
  const activeId = store.getState().workspace.activePaneId;
  if (activeId === null) {
    return;
  }
  splitPane(activeId, direction);
}

function closeActivePane(store: StationStore, closePane: (paneId: PaneId) => void): void {
  const { activePaneId, panes } = store.getState().workspace;
  // Mirror the context menu's close guard fully: keyboard close is for pane
  // management — never the main pane (the boot pane the layout roots on) and
  // never the last pane, so it can't drop into an empty workspace / welcome
  // screen (the Zero-Pane State UI is deferred).
  if (activePaneId === null || activePaneId === MAIN_PANE_ID || panes.length <= 1) {
    return;
  }
  closePane(activePaneId);
}

export type StationPasteEvent = { bytes: Uint8Array; preventDefault(): void };

export type StationInputRuntime = {
  /** For prependInputHandlers; returns true when the sequence was consumed. */
  handleSequence(sequence: string): boolean;
  /** For renderer.keyInput.on("paste"); prevents default only on delivery. */
  handlePaste(event: StationPasteEvent): void;
  /** For renderable onMouseDown handlers; returns true when consumed. */
  dispatchMouse(target: MouseTargetRef, event: StationMouseEvent): boolean;
};

export type StationInputRuntimeOptions = {
  store: StationStore;
  shutdown(): void;
  /** Registers the STATION dashboard layer + mouse targets when provided. */
  stationViewStore?: StoreApi<TuiStore>;
  keymap?: KeymapStack<RouteOutcome>;
  mouseBindings?: MouseBindings;
  /** Runtime PTY resources; terminal writes/pastes resolve through it. */
  registry?: PtyRegistry;
  /**
   * Per-pane shell placement. Returns a host-attached terminal creator when the
   * host is up; returns `undefined` so the registry opens an ordinary local shell.
   * Absent in tests/mock mode ⇒ aux shells are always local.
   */
  resolveAuxShellPlacement?: AuxShellPlacement;
  /** Observer service for managed primary-agent launches; absent in mock mode. */
  observerService?: ObserverService;
  openExternalUrl?: (url: string) => void;
  /** Configured automations surfaced in the pane context menu; default none. */
  automations?: readonly Automation[];
  writeToTerminal?: (paneId: PaneId, bytes: string) => boolean;
  pasteToTerminal?: (paneId: PaneId, text: string) => boolean;
  /**
   * When true, opening a pane from the STATION overlay closes the overlay so the
   * new/revealed shell is revealed immediately. Default false: the overlay
   * stays up and the pane becomes its queued return-focus target.
   */
  autoCloseOverlayOnPaneOpen?: boolean;
};

/**
 * The composition point: normalize -> route -> execute. Pure routing lives in
 * router.ts/keymaps.ts; registrations live in stationBindings.ts; pane effects and
 * the managed-launch lifecycle live in paneEffects.ts/managedLaunch.ts; this wires
 * them to the store, the terminal registry, and app commands.
 */
export function createStationInputRuntime(options: StationInputRuntimeOptions): StationInputRuntime {
  const keymap = options.keymap ?? createStationKeymap(options.stationViewStore);
  const mouseBindings = options.mouseBindings ?? createStationMouseBindings(options.stationViewStore);
  const registry = options.registry;

  const paneEffects = createPaneEffects({
    store: options.store,
    stationViewStore: options.stationViewStore,
    registry,
    resolveAuxShellPlacement: options.resolveAuxShellPlacement,
    autoCloseOverlay: options.autoCloseOverlayOnPaneOpen ?? false,
    automations: options.automations ?? [],
    writeToTerminal: options.writeToTerminal,
    pasteToTerminal: options.pasteToTerminal,
  });
  const managed = createManagedLaunch({
    store: options.store,
    stationViewStore: options.stationViewStore,
    observerService: options.observerService,
    registry,
  });

  // Pane chords are `reserved`, so they pierce the context-menu catch-all; gate on that real modal
  // state so split/close/focus stay inert while a context menu owns the screen.
  const blockedByModal = (): boolean => options.store.getState().input.contextMenu !== null;
  const paneCommand = (run: () => void): (() => void) => {
    return () => {
      if (blockedByModal()) {
        return;
      }
      run();
    };
  };
  const commands: Record<StationCommandId, () => void> = {
    "station.exit": options.shutdown,
    "station.splitRight": paneCommand(() =>
      splitActivePane(options.store, paneEffects.splitPane, "right"),
    ),
    "station.splitBelow": paneCommand(() =>
      splitActivePane(options.store, paneEffects.splitPane, "below"),
    ),
    "station.focusNextPane": paneCommand(() => options.store.actions.focusNextPane()),
    "station.closeActivePane": paneCommand(() => closeActivePane(options.store, paneEffects.closePane)),
  };

  const effects: StationInputEffects = {
    store: options.store,
    automations: options.automations ?? [],
    runCommand: (commandId) => {
      commands[commandId]();
    },
    writeToTerminal: paneEffects.writeToTerminal,
    pasteToTerminal: paneEffects.pasteToTerminal,
    scrollTerminal: paneEffects.scrollTerminal,
    openPane: paneEffects.openPane,
    splitPane: paneEffects.splitPane,
    runAutomation: paneEffects.runAutomation,
    closePane: paneEffects.closePane,
    launchPrimaryAgent: managed.launchPrimaryAgent,
    launchHostedNewSession: managed.launchHostedNewSession,
    openExternalUrl: options.openExternalUrl ?? (() => {}),
  };
  if (options.stationViewStore !== undefined) {
    effects.stationViewStore = options.stationViewStore;
  }

  return {
    handleSequence: (sequence) => {
      const state = options.store.getState();
      const normalized = normalizeSequence(sequence, {
        preserveModifiedEnter: focusedPaneAcceptsModifiedEnter(state, registry, (providerId) =>
          providerSupportsModifiedEnterSoftNewline(
            options.stationViewStore?.getState().snapshot,
            providerId,
          ),
        ),
      });
      if (normalized.consumed) {
        return true;
      }
      return executeOutcome(routeKey(normalized.legacy, state, keymap), effects);
    },
    handlePaste: (event) => {
      const text = new TextDecoder().decode(event.bytes);
      if (options.store.getState().input.focus.kind === "contextMenu") {
        event.preventDefault();
        return;
      }
      // While STATION mode is up, paste belongs to the dashboard's text-input
      // modes (search, name editors) — apps/tui receives pastes as plain
      // input chunks, and the shared machine treats them the same way. The
      // chunk is sanitized first (the key path's control-byte discipline
      // applies to this channel too), and a dismiss outcome — a one-char
      // paste can match a bound key — closes the overlay like a keypress.
      if (
        options.stationViewStore !== undefined &&
        options.store.getState().input.activeOverlay === STATION_OVERLAY_ID
      ) {
        event.preventDefault();
        const sanitized = sanitizePastedText(text);
        if (sanitized.length === 0) {
          return;
        }
        const outcome = dispatchStationKey(options.stationViewStore, { input: sanitized });
        if (outcome.kind === "close-overlay") {
          executeOutcome({ kind: "overlay-close", overlayId: STATION_OVERLAY_ID }, effects);
        }
        return;
      }
      if (executeOutcome(routePaste(text, options.store.getState()), effects)) {
        event.preventDefault();
      }
    },
    dispatchMouse: (target, event) => {
      return executeOutcome(routeMouse(target, event, options.store.getState(), mouseBindings), effects);
    },
  };
}

import { kittySequenceToLegacy } from "../terminal/index.js";
import { stripTerminalReplies } from "../terminal/input/terminalReplies.js";
import { createHostAttachedTerminal } from "../terminal/pty/hostAttachedTerminal.js";
import type { AuxShellPlacement } from "../terminal/pty/auxShellPlacement.js";
import { buildWheelForwardSequence } from "../terminal/input/wheelForward.js";
import { cursorKeyBytes } from "../terminal/protocol/cursorKeys.js";
import { MouseEncoding } from "../terminal/protocol/mouse.js";
import type { PtyRegistry, PtyRegistryView } from "../terminal/registry/ptyRegistry.js";
import type { Automation } from "../config/stationConfig.js";
import type { StationTerminalSpawnOptions } from "../terminal/types.js";
import type { StoreApi } from "zustand/vanilla";
import { selectPaneRecord } from "../state/selectors.js";
import { buildContextMenuItems, resolveContextMenuAction } from "../contextMenu/items.js";
import type { CreatePaneOptions, StationStore } from "../state/store.js";
import {
  agentWorktreePaneId,
  MAIN_PANE_ID,
  STATION_OVERLAY_ID,
  worktreePaneId,
  type AgentIdentity,
  type PaneId,
  type PaneRole,
  type PaneSplitDirection,
  type StationState,
} from "../state/types.js";
import { sanitizePastedText } from "../station/input/sequenceToTuiKey.js";
import { dispatchStationKey } from "../station/input/stationActions.js";
import { safeErrorToNotice, toSafeError, type ObserverService } from "@station/client";
import { STATION_HOST_PROVIDER_ID } from "@station/host";
import type { ProviderId, WorktreeRow, StationCommand, StationSnapshot } from "@station/contracts";
import {
  addPendingCreateSessionRow,
  openForkDetailsForRow,
  openRemoveWorktreeConfirmForRow,
  openRenameEditForRow,
  removeCreateSessionLocalRow,
} from "@station/dashboard-core";
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

export type NormalizedSequence = { consumed: true } | { consumed: false; legacy: string };

/**
 * Normalize bytes before routing so raw kitty sequences, empty keys, and
 * unconsumed terminal query replies never reach shell input.
 */
export function normalizeSequence(
  raw: string,
  options?: { preserveModifiedEnter?: boolean },
): NormalizedSequence {
  const stripped = stripTerminalReplies(raw);
  if (stripped === "" && raw !== "") {
    return { consumed: true };
  }
  const legacy = kittySequenceToLegacy(stripped, options);
  if (legacy === "") {
    // Key releases and untranslatable functional keys: consumed, not leaked.
    return { consumed: true };
  }
  return { consumed: false, legacy };
}

function paneInputBytes(bytes: string, registry: PtyRegistryView | undefined, paneId: PaneId): string {
  const cursor = CURSOR_KEY_BYTES.get(bytes);
  if (cursor === undefined) {
    return bytes;
  }
  return registry?.get(paneId)?.screen?.isApplicationCursorKeys() === true
    ? cursor.application
    : cursor.normal;
}

const CURSOR_KEY_BYTES = cursorKeyBytes();

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

/** What a managed primary-agent launch needs to ask the observer to prepare it. */
export type ManagedLaunchTarget = {
  projectId: string;
  worktreeId: string;
  cwd: string;
  /**
   * Harness to launch when minting a fresh session (the New Session wizard's
   * pick). Absent for a row click, where the observer uses the worktree's
   * remembered harness or the project default.
   */
  harness?: ProviderId;
  /**
   * Spawn the agent pane but leave the STATION overlay open and unfocused — the New
   * Session flow stays on the dashboard (optimistic row visible) instead of being
   * yanked into the pane. A row click omits this and "brings the user there".
   */
  background?: boolean;
};

/** Lines of scrollback per wheel tick, and arrow repeats per tick when a
 * fullscreen pager owns the screen. Not yet configurable. */
const WHEEL_LINES = 3;

const SPLIT_PANE_ID_PREFIX = "pane-split-";

/**
 * How long an automation waits for a freshly split pane's PTY to spawn (it does
 * so lazily on first layout/resize) before giving up on sending its command, so
 * a pane that is never laid out doesn't leak a registry subscription.
 */
const AUTOMATION_SEND_TIMEOUT_MS = 10_000;

/**
 * Resume split numbering from live panes so restored/HMR-surviving split ids are
 * never reused and silently dropped as duplicates.
 */
export function nextSplitSeqFromPanes(panes: readonly { id: PaneId }[]): number {
  let max = -1;
  for (const pane of panes) {
    if (!pane.id.startsWith(SPLIT_PANE_ID_PREFIX)) {
      continue;
    }
    // Digits only: `Number("")` / `Number(" ")` are 0, so a bare `pane-split-`
    // (reachable from hand-edited disk JSON) would otherwise raise max to 0.
    const suffix = pane.id.slice(SPLIT_PANE_ID_PREFIX.length);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }
    const n = Number(suffix);
    if (n > max) {
      max = n;
    }
  }
  return max + 1;
}

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
  /**
   * Seed a worktree off a source's HEAD (worktree.fork) and host the inherited
   * harness in a Station pane (the Fork details screen's submit). Fire-and-forget
   * like launchHostedNewSession; failures surface as a STATION toast.
   */
  launchHostedForkSession(target: {
    projectId: string;
    sourceWorktreeId: string;
    branch: string;
    copyDirty: boolean;
  }): void;
  openExternalUrl(url: string): void;
};

/**
 * Applies a route outcome and reports whether the input was consumed.
 * Terminal delivery propagates the registry's result: with no live terminal
 * attached (process exited, pane unmounting) this returns false so OpenTUI's
 * own handlers still see the sequence.
 */
export function executeOutcome(outcome: RouteOutcome, effects: StationInputEffects): boolean {
  switch (outcome.kind) {
    case "command":
      effects.runCommand(outcome.commandId);
      return true;
    case "terminal-write":
      return effects.writeToTerminal(outcome.paneId, outcome.bytes);
    case "terminal-paste":
      return effects.pasteToTerminal(outcome.paneId, outcome.text);
    case "terminal-scroll":
      return effects.scrollTerminal(outcome.paneId, outcome.direction);
    case "focus":
      // Only pane focus arrives as a bare focus outcome; overlay focus changes
      // are expressed as overlay outcomes and actions.
      if (outcome.target.kind === "pane") {
        effects.store.actions.focusPane(outcome.target.paneId);
      }
      return true;
    case "overlay-open":
      // Opening the dashboard moves past the boot intro; dismiss it so closing
      // the overlay later lands on the workspace, not back on the intro. No-op
      // when the intro is not showing.
      effects.store.actions.dismissWelcomeIntro();
      effects.store.actions.openOverlay(outcome.overlayId);
      return true;
    case "welcome-dismiss":
      effects.store.actions.dismissWelcomeIntro();
      return true;
    case "overlay-close":
      effects.store.actions.closeOverlay();
      return true;
    case "context-menu-open":
      effects.store.actions.openContextMenu(outcome.target, outcome.anchor);
      return true;
    case "context-menu-close":
      effects.store.actions.closeContextMenu();
      return true;
    case "context-menu-move":
      moveContextMenuSelection(outcome.delta, effects);
      return true;
    case "context-menu-set-active":
      effects.store.actions.setContextMenuActiveIndex(outcome.index);
      return true;
    case "context-menu-select":
      selectContextMenuItem(effects, outcome.itemIndex);
      return true;
    case "pane-open": {
      // Explicit assignments keep command/args/worktreeId absent (not set to
      // undefined) on the shell path — exactOptionalPropertyTypes.
      const spawn: OpenPaneSpawn = { cwd: outcome.cwd, role: outcome.role };
      if (outcome.command !== undefined) {
        spawn.command = outcome.command;
      }
      if (outcome.args !== undefined) {
        spawn.args = outcome.args;
      }
      if (outcome.worktreeId !== undefined) {
        spawn.worktreeId = outcome.worktreeId;
      }
      effects.openPane(outcome.paneId, spawn);
      return true;
    }
    case "pane-launch-managed":
      // Fire-and-forget: the launch is async (it round-trips to the observer),
      // but the input is consumed now so OpenTUI does not also act on the click.
      effects.launchPrimaryAgent(outcome.paneId, {
        projectId: outcome.projectId,
        worktreeId: outcome.worktreeId,
        cwd: outcome.cwd,
      });
      return true;
    case "pane-launch-new-session":
      effects.launchHostedNewSession({
        projectId: outcome.projectId,
        branch: outcome.branch,
        harness: outcome.harness,
      });
      return true;
    case "pane-launch-fork":
      effects.launchHostedForkSession({
        projectId: outcome.projectId,
        sourceWorktreeId: outcome.sourceWorktreeId,
        branch: outcome.branch,
        copyDirty: outcome.copyDirty,
      });
      return true;
    case "open-url":
      effects.openExternalUrl(outcome.url);
      return true;
    case "swallowed":
      return true;
    case "ignored":
      return false;
  }
}

/** How long to wait for a freshly created worktree's row to reach the snapshot. */
const WORKTREE_APPEAR_TIMEOUT_MS = 10_000;

function findWorktreeRowById(
  store: StoreApi<TuiStore>,
  worktreeId: string,
): WorktreeRow | undefined {
  return store.getState().snapshot?.rows.find((row) => row.id === worktreeId);
}

function findWorktreeRowByBranch(
  store: StoreApi<TuiStore>,
  projectId: string,
  branch: string,
): WorktreeRow | undefined {
  return store
    .getState()
    .snapshot?.rows.find((row) => row.projectId === projectId && row.branch === branch);
}

// The harness a fork inherits: the source's live/recovery harness, else the
// project default — shared by the optimistic row and the launch.
function inheritedForkHarness(
  store: StoreApi<TuiStore>,
  projectId: string,
  sourceWorktreeId: string,
): ProviderId | undefined {
  const snapshot = store.getState().snapshot;
  const source = snapshot?.rows.find((row) => row.id === sourceWorktreeId);
  const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
  return source?.agent?.harness ?? source?.recovery?.provider ?? project?.defaults.harness;
}

/**
 * The external (non-Station) terminal provider holding this worktree, or
 * undefined when it's Station-hosted (focusable/reattachable) or unknown. Used to
 * tell the user a tmux agent can't be shown in Station rather than focus it to no
 * visible effect.
 */
function externalTerminalProviderForWorktree(
  store: StoreApi<TuiStore>,
  worktreeId: string,
): string | undefined {
  const provider = findWorktreeRowById(store, worktreeId)?.terminal?.provider;
  return provider !== undefined && provider !== STATION_HOST_PROVIDER_ID ? provider : undefined;
}

function nonFocusableStationTerminalForWorktree(
  store: StoreApi<TuiStore>,
  worktreeId: string,
): { label: string } | undefined {
  const row = findWorktreeRowById(store, worktreeId);
  const terminal = row?.terminal;
  if (row === undefined || terminal?.provider !== STATION_HOST_PROVIDER_ID) {
    return undefined;
  }
  return terminal.focusable === true ? undefined : { label: row.branch };
}

/**
 * Resolve once the created worktree's row reaches the snapshot — it arrives on
 * the observer's next reconcile, seconds after worktree.create completes — or
 * undefined on timeout. Subscribes rather than polls so it settles on the first
 * snapshot carrying the row.
 */
function waitForWorktreeByBranch(
  store: StoreApi<TuiStore>,
  projectId: string,
  branch: string,
): Promise<WorktreeRow | undefined> {
  const existing = findWorktreeRowByBranch(store, projectId, branch);
  if (existing !== undefined) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const settle = (row: WorktreeRow | undefined): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(row);
    };
    const timer = setTimeout(() => settle(undefined), WORKTREE_APPEAR_TIMEOUT_MS);
    const unsubscribe = store.subscribe(() => {
      const row = findWorktreeRowByBranch(store, projectId, branch);
      if (row !== undefined) {
        settle(row);
      }
    });
  });
}

/**
 * Return the STATION view store to the dashboard from the New Session wizard via the
 * shared reducer (Escape backs out a step; from review that lands on the
 * dashboard). Station hosts the create itself, so the wizard's own tmux submit
 * must not also run.
 */
function closeNewSessionWizard(store: StoreApi<TuiStore> | undefined): void {
  if (store !== undefined && store.getState().screen.name === "newSession") {
    dispatchStationKey(store, { input: "", escape: true });
  }
}

function closeForkSheet(store: StoreApi<TuiStore> | undefined): void {
  if (store === undefined) {
    return;
  }
  // Submit is intercepted before submitFork runs, so unwind to the dashboard
  // here. Esc steps details → chooseSlot → dashboard; the cap can't spin.
  for (let hop = 0; hop < 2 && store.getState().screen.name === "fork"; hop += 1) {
    dispatchStationKey(store, { input: "", escape: true });
  }
}

function splitActivePane(effects: StationInputEffects, direction: PaneSplitDirection): void {
  const activeId = effects.store.getState().workspace.activePaneId;
  if (activeId === null) {
    return;
  }
  effects.splitPane(activeId, direction);
}

function closeActivePane(effects: StationInputEffects): void {
  const { activePaneId, panes } = effects.store.getState().workspace;
  // Mirror the context menu's close guard fully: keyboard close is for pane
  // management — never the main pane (the boot pane the layout roots on) and
  // never the last pane, so it can't drop into an empty workspace / welcome
  // screen (the Zero-Pane State UI is deferred).
  if (activePaneId === null || activePaneId === MAIN_PANE_ID || panes.length <= 1) {
    return;
  }
  effects.closePane(activePaneId);
}

function moveContextMenuSelection(delta: -1 | 1, effects: StationInputEffects): void {
  const store = effects.store;
  const state = store.getState();
  const menu = state.input.contextMenu;
  if (menu === null) {
    return;
  }
  const items = buildContextMenuItems(
    menu.target,
    state,
    effects.stationViewStore?.getState(),
    effects.automations,
  );
  if (items.length === 0) {
    return;
  }
  const next = (menu.activeIndex + delta + items.length) % items.length;
  store.actions.setContextMenuActiveIndex(next);
}

function selectContextMenuItem(
  effects: StationInputEffects,
  itemIndex: number | undefined,
): void {
  const store = effects.store;
  const state = store.getState();
  const menu = state.input.contextMenu;
  if (menu === null) {
    return;
  }
  const stationViewStore = effects.stationViewStore;
  const items = buildContextMenuItems(
    menu.target,
    state,
    stationViewStore?.getState(),
    effects.automations,
  );
  const item = items[itemIndex ?? menu.activeIndex];
  const action = resolveContextMenuAction(item);
  if (action === undefined) {
    return;
  }
  store.actions.closeContextMenu();
  switch (action.kind) {
    case "noop":
      return;
    case "splitPane":
      effects.splitPane(action.paneId, action.direction);
      return;
    case "runAutomation":
      effects.runAutomation(action.automationId, action.paneId);
      return;
    case "closePane":
      effects.closePane(action.paneId);
      return;
    case "renameSession":
      if (stationViewStore !== undefined) {
        stationViewStore.setState(
          openRenameEditForRow(stationViewStore.getState(), action.rowId, {
            returnTo: "dashboard",
          }),
        );
        effects.store.actions.openOverlay(STATION_OVERLAY_ID);
      }
      return;
    case "removeWorktree":
      if (stationViewStore !== undefined) {
        stationViewStore.setState(
          openRemoveWorktreeConfirmForRow(stationViewStore.getState(), action.rowId),
        );
      }
      return;
    case "forkSession":
      if (stationViewStore !== undefined) {
        stationViewStore.setState(
          openForkDetailsForRow(stationViewStore.getState(), action.rowId, "dashboard"),
        );
        effects.store.actions.openOverlay(STATION_OVERLAY_ID);
      }
      return;
  }
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
 * The composition point: normalize -> route -> execute. Pure routing lives
 * in router.ts/keymaps.ts; registrations live in stationBindings.ts; this
 * wires them to the store, the terminal registry, and app commands.
 */
export function createStationInputRuntime(options: StationInputRuntimeOptions): StationInputRuntime {
  const keymap = options.keymap ?? createStationKeymap(options.stationViewStore);
  const mouseBindings = options.mouseBindings ?? createStationMouseBindings(options.stationViewStore);
  // Pane chords are `reserved`, so they pierce the context-menu catch-all; gate
  // on that real modal state so split/close/focus stay inert while a context
  // menu owns the screen. `effects` is read lazily — these closures only run
  // once a chord fires, by which point it is initialized.
  const blockedByModal = (): boolean => {
    const input = options.store.getState().input;
    return input.contextMenu !== null;
  };
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
    "station.splitRight": paneCommand(() => splitActivePane(effects, "right")),
    "station.splitBelow": paneCommand(() => splitActivePane(effects, "below")),
    "station.focusNextPane": paneCommand(() => options.store.actions.focusNextPane()),
    "station.closeActivePane": paneCommand(() => closeActivePane(effects)),
  };
  const registry = options.registry;
  const autoCloseOverlay = options.autoCloseOverlayOnPaneOpen ?? false;
  // Monotonic split-id source, seeded above any existing split id so restored / HMR-surviving
  // splits keep theirs and a fresh split can't collide with one already in the store.
  let splitSeq = nextSplitSeqFromPanes(options.store.getState().workspace.panes);
  // Guards a managed launch's async window: between a click's synchronous return
  // and its `prepareExternalLaunch` resolving, no pane record exists yet, so a
  // second click would otherwise fire a second prepare for the same pane and
  // orphan an observer session/target. Keyed by the deterministic agent pane id.
  const launchesInFlight = new Set<PaneId>();
  const effects: StationInputEffects = {
    store: options.store,
    automations: options.automations ?? [],
    runCommand: (commandId) => {
      commands[commandId]();
    },
    writeToTerminal:
      options.writeToTerminal ??
      ((paneId, bytes) => {
        registry?.get(paneId)?.screen?.scrollToBottom();
        return registry?.write(paneId, paneInputBytes(bytes, registry, paneId)) ?? false;
      }),
    pasteToTerminal:
      options.pasteToTerminal ??
      ((paneId, text) => {
        registry?.get(paneId)?.screen?.scrollToBottom();
        return registry?.paste(paneId, text) ?? false;
      }),
    scrollTerminal: (paneId, direction) => {
      const screen = registry?.get(paneId)?.screen;
      if (!screen) {
        return false;
      }
      // Alt-screen / mouse-reporting app owns the wheel: forward it as input so the app scrolls
      // natively. Uses registry.write, not writeToTerminal, so it doesn't trip snap-to-bottom.
      if (screen.isAltScreen() || screen.isMouseReportingEnabled()) {
        const stats = screen.bufferStats();
        const bytes = buildWheelForwardSequence({
          direction,
          mouseReporting: screen.isMouseReportingEnabled(),
          encoding: screen.mouseProtocol()?.encoding ?? MouseEncoding.Legacy,
          applicationCursorKeys: screen.isApplicationCursorKeys(),
          cols: stats.cols,
          rows: stats.rows,
          lines: WHEEL_LINES,
        });
        return registry?.write(paneId, bytes) ?? false;
      }
      // Normal buffer: scroll our own scrollback. Up = back into history.
      return screen.scrollBy(direction === "up" ? WHEEL_LINES : -WHEEL_LINES);
    },
    // Open-or-focus a `[+sh]` shell pane with a stable id. On first open, seed
    // the registry entry with the cwd *before* createPane: PtyRegistry.ensure
    // stores spawnOptions only when it first creates the entry, and the pane
    // reconciler's later no-option ensure(paneId) is then an idempotent no-op
    // that preserves them. Reverse the order and the spawn options are silently
    // lost. (Managed primary agents take the launchPrimaryAgent path instead.)
    openPane: (paneId, spawn) => {
      const { cwd, command, args } = spawn;
      const role = spawn.role ?? "shell";
      if (selectPaneRecord(options.store.getState(), paneId) !== null) {
        options.store.actions.revealPane(paneId);
      } else {
        const spawnOptions: StationTerminalSpawnOptions = { cwd };
        if (command !== undefined) {
          spawnOptions.command = command;
        }
        if (args !== undefined) {
          spawnOptions.args = args;
        }
        // A plain shell (no explicit command) lands in the host when the daemon is up so it
        // persists across a restart; a pane carrying its own command stays local.
        const createTerminal =
          command === undefined && role === "shell"
            ? options.resolveAuxShellPlacement?.(paneId)
            : undefined;
        registry?.ensure(paneId, spawnOptions, createTerminal);
        const createOptions: CreatePaneOptions = { role };
        // Tile the shell beside the worktree's agent pane when it exists, else split off the active
        // pane; rooting its own session stacked a full-screen pane over the current one.
        const split = shellSplitForWorktree(spawn, role) ?? activeShellSplit(role);
        if (split !== undefined) {
          createOptions.split = split;
        }
        options.store.actions.createPane(paneId, createOptions);
      }
      if (autoCloseOverlay || role === "primary-agent") {
        options.store.actions.closeOverlay();
      }
    },
    splitPane: (anchorPaneId, direction) => {
      const newId: PaneId = `${SPLIT_PANE_ID_PREFIX}${splitSeq++}`;
      // Inherit the anchor's live spawn cwd (goes stale once that shell cd's), falling back to its
      // worktree path. Threaded only when present so an undefined cwd stays absent under
      // exactOptionalPropertyTypes. Ensure-before-createPane (see openPane) keeps the spawn options.
      const cwd = registry?.get(anchorPaneId)?.cwd ?? splitCwdForAnchor(anchorPaneId);
      // Host-placed when the daemon is up (survives a UI restart), else local.
      const createTerminal = options.resolveAuxShellPlacement?.(newId);
      registry?.ensure(newId, cwd === undefined ? undefined : { cwd }, createTerminal);
      options.store.actions.createPane(newId, { split: { anchorPaneId, direction } });
    },
    runAutomation: (automationId, anchorPaneId) => {
      const automation = effects.automations.find((entry) => entry.id === automationId);
      if (automation === undefined || !automation.enabled) {
        return;
      }
      // All steps open in the anchor's worktree root (immutable, deterministic),
      // falling back to the anchor's live spawn cwd.
      const cwd = splitCwdForAnchor(anchorPaneId) ?? registry?.get(anchorPaneId)?.cwd;
      let previousPaneId = anchorPaneId;
      let focusTarget: PaneId | undefined;
      for (const step of automation.steps) {
        const stepAnchor = step.anchor === "origin" ? anchorPaneId : previousPaneId;
        const newId: PaneId = `${SPLIT_PANE_ID_PREFIX}${splitSeq++}`;
        // Host-placed when the daemon is up (survives a UI restart), like splitPane.
        const createTerminal = options.resolveAuxShellPlacement?.(newId);
        registry?.ensure(newId, cwd === undefined ? undefined : { cwd }, createTerminal);
        // Ensure-before-createPane (see openPane); a prior step's anchor already exists, so the chained split resolves.
        options.store.actions.createPane(newId, {
          split: { anchorPaneId: stepAnchor, direction: step.split },
        });
        // Execute appends CR (the shell's line terminator) to auto-submit; write leaves the command typed for review.
        sendWhenReady(newId, step.run === "execute" ? `${step.command}\r` : step.command);
        previousPaneId = newId;
        if (step.focus) {
          focusTarget = newId;
        }
      }
      options.store.actions.focusPane(focusTarget ?? previousPaneId);
    },
    closePane: (paneId) => {
      // Destroy the process before dropping the record. kill() closes a host-owned
      // aux PTY on the host (so a closed pane never lingers as a reattachable
      // orphan), kills a local shell's bridge, and is a no-op for an attached
      // agent (the observer owns it — the pane then just detaches on dispose).
      registry?.get(paneId)?.terminal?.kill();
      options.store.actions.closePane(paneId);
    },
    launchPrimaryAgent: (paneId, target) => {
      // Fire-and-forget so executeOutcome stays synchronous; any throw becomes a toast, never an
      // unhandled rejection, so the failures-toast contract holds end to end.
      void runManagedLaunch(paneId, target).catch((error) => {
        pushLaunchError(error);
      });
    },
    launchHostedNewSession: (target) => {
      // Harness comes from the wizard pick; New Session keeps the overlay open.
      closeNewSessionWizard(options.stationViewStore);
      startHostedWorktreeLaunch({
        localId: `station-create:${target.projectId}:${target.branch}`,
        projectId: target.projectId,
        branch: target.branch,
        harness: target.harness,
        command: {
          type: "worktree.create",
          payload: { projectId: target.projectId, branch: target.branch },
        },
        verb: "create",
      });
    },
    launchHostedForkSession: (target) => {
      // Fork inherits the source's harness (the seeded worktree has none yet).
      closeForkSheet(options.stationViewStore);
      const viewStore = options.stationViewStore;
      startHostedWorktreeLaunch({
        localId: `station-fork:${target.sourceWorktreeId}:${target.branch}`,
        projectId: target.projectId,
        branch: target.branch,
        harness:
          viewStore === undefined
            ? undefined
            : inheritedForkHarness(viewStore, target.projectId, target.sourceWorktreeId),
        command: { type: "worktree.fork", payload: { ...target } },
        verb: "fork",
      });
    },
    openExternalUrl: options.openExternalUrl ?? (() => {}),
  };
  if (options.stationViewStore !== undefined) {
    effects.stationViewStore = options.stationViewStore;
  }

  function shellSplitForWorktree(
    spawn: OpenPaneSpawn,
    role: PaneRole,
  ): { anchorPaneId: PaneId; direction: PaneSplitDirection } | undefined {
    if (role !== "shell" || spawn.worktreeId === undefined) {
      return undefined;
    }
    const agentPaneId = agentWorktreePaneId(spawn.worktreeId);
    if (selectPaneRecord(options.store.getState(), agentPaneId) === null) {
      return undefined;
    }
    return { anchorPaneId: agentPaneId, direction: "right" };
  }

  // Fallback anchor for a shell with no worktree agent: prefer the active pane, else the first
  // record (it roots the on-screen tree). Only a truly empty workspace has nothing to tile
  // against, so the first shell still roots a session.
  function activeShellSplit(
    role: PaneRole,
  ): { anchorPaneId: PaneId; direction: PaneSplitDirection } | undefined {
    if (role !== "shell") {
      return undefined;
    }
    const { panes, activePaneId } = options.store.getState().workspace;
    const anchorPaneId = activePaneId ?? panes[0]?.id;
    if (anchorPaneId === undefined) {
      return undefined;
    }
    return { anchorPaneId, direction: "right" };
  }

  function splitCwdForAnchor(anchorPaneId: PaneId): string | undefined {
    const rows = options.stationViewStore?.getState().snapshot?.rows;
    if (rows === undefined) {
      return undefined;
    }
    const worktreeId = worktreeIdForPane(anchorPaneId, rows);
    return rows.find((row) => row.id === worktreeId)?.path;
  }

  // The split anchor chain is acyclic by construction (createPane validates the
  // anchor already exists; closePane only clears anchors), so this walk to the
  // worktree-owning pane terminates without a cycle guard.
  function worktreeIdForPane(paneId: PaneId, rows: readonly WorktreeRow[]): string | undefined {
    const workspace = options.store.getState().workspace;
    for (const row of rows) {
      if (agentWorktreePaneId(row.id) === paneId || worktreePaneId(row.id) === paneId) {
        return row.id;
      }
    }

    const pane = workspace.panes.find((candidate) => candidate.id === paneId);
    if (pane?.split === null || pane?.split === undefined) {
      return undefined;
    }
    return worktreeIdForPane(pane.split.anchorPaneId, rows);
  }

  // A split pane's PTY spawns lazily on its first layout/resize, so its terminal
  // is null right after createPane. Send the command on the registry's spawn
  // notify instead, then stop listening; a safety timeout drops the subscription
  // if the pane is never laid out (or is closed) before it spawns. A layout that
  // arrives after the timeout finds no subscriber, so the command is silently
  // dropped — the unlaid-out-for-10s pane is already a degenerate case.
  function sendWhenReady(paneId: PaneId, payload: string): void {
    const reg = registry;
    if (payload.length === 0 || reg === undefined) {
      return;
    }
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      unsubscribe?.();
    };
    const attempt = (): void => {
      const entry = reg.get(paneId);
      if (entry === undefined || entry.exited) {
        finish();
        return;
      }
      if (entry.terminal !== null) {
        effects.writeToTerminal(paneId, payload);
        finish();
      }
    };
    attempt();
    if (settled) {
      return;
    }
    unsubscribe = reg.subscribe(attempt);
    timer = setTimeout(finish, AUTOMATION_SEND_TIMEOUT_MS);
  }

  function clearPendingCreateRow(localId: string): void {
    const viewStore = options.stationViewStore;
    if (viewStore !== undefined) {
      viewStore.setState(removeCreateSessionLocalRow(viewStore.getState(), localId));
    }
  }

  // Seed the registry entry (observer-built command/args/env) *before* createPane, same ordering
  // reason openPane documents, then record the STATION identity so the agent's exit can be reported.
  async function runManagedLaunch(paneId: PaneId, target: ManagedLaunchTarget): Promise<void> {
    // Background launch (New Session) keeps the overlay open on the dashboard; a row click lands the user in the pane.
    const landInPane = target.background !== true;
    const turnReadiness = readinessForWorktree(target.worktreeId);
    if (selectPaneRecord(options.store.getState(), paneId) !== null) {
      if (landInPane) {
        options.store.actions.revealPane(paneId);
        options.store.actions.closeOverlay();
        await acknowledgeTurnReadiness(turnReadiness);
      }
      return;
    }
    // A detached/stale terminal is running but not attached anywhere Station can render; report
    // where it lives instead of dispatching a terminal.focus the observer accepts yet paints
    // nothing (the silent "this row won't open" case). Open terminals fall through below.
    const unreachable = unreachableTerminalRow(target.worktreeId);
    if (unreachable !== undefined) {
      pushLaunchToast(
        `${unreachable.label}: agent is ${unreachable.state} under '${unreachable.provider}'; Station can't focus it here.`,
        "info",
      );
      return;
    }
    // A launch for this pane is already underway (its pane record does not exist
    // yet); a second click must not fire a second prepare.
    if (launchesInFlight.has(paneId)) {
      return;
    }
    const observerService = options.observerService;
    if (observerService === undefined) {
      pushLaunchToast("No observer connection; cannot launch the agent.");
      return;
    }
    launchesInFlight.add(paneId);
    try {
      let prepared: Awaited<ReturnType<ObserverService["prepareExternalLaunch"]>>;
      try {
        const prepareParams: Parameters<ObserverService["prepareExternalLaunch"]>[0] = {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        };
        // Honor the New Session wizard's harness pick when minting a fresh session;
        // a row click leaves it absent (observer uses remembered/default).
        if (target.harness !== undefined) {
          prepareParams.harness = target.harness;
        }
        prepared = await observerService.prepareExternalLaunch(prepareParams);
      } catch (error) {
        pushLaunchError(error);
        return;
      }
      // A persistent host PTY backs this worktree (the observer spawned it): attach to the host
      // instead of spawning locally. Covers both a fresh launch and a reopen onto a running agent.
      if (prepared.reattachHandle !== undefined) {
        const handle = prepared.reattachHandle;
        registry?.ensure(paneId, { cwd: target.cwd }, (spawn) =>
          createHostAttachedTerminal({
            hostSocketPath: handle.hostSocketPath,
            ptyId: handle.ptyId,
            size: { cols: spawn.size?.cols ?? 80, rows: spawn.size?.rows ?? 24 },
          }),
        );
        options.store.actions.createPane(paneId, { role: "primary-agent" });
        const identity: AgentIdentity = {
          sessionId: prepared.sessionId,
          terminalTargetId: handle.terminalTargetId,
          harnessProvider:
            prepared.kind === "prepared" ? prepared.launchPlan.provider : prepared.harnessProvider,
        };
        options.store.actions.setPrimaryAgent(paneId, identity);
        if (landInPane) {
          options.store.actions.closeOverlay();
          await acknowledgeTurnReadiness(turnReadiness);
        }
        return;
      }

      if (prepared.kind === "existing-session") {
        // A live agent already holds this worktree (the reattach-handle branch above returned). If it
        // runs in an external terminal (tmux) Station can't render, say so — focusing would have no
        // visible effect; otherwise focus it via the observer.
        const nonFocusableStation =
          options.stationViewStore !== undefined
            ? nonFocusableStationTerminalForWorktree(options.stationViewStore, target.worktreeId)
            : undefined;
        if (nonFocusableStation !== undefined) {
          pushLaunchToast(
            `${nonFocusableStation.label}: Station has no attachable host PTY for this existing agent.`,
            "info",
          );
          return;
        }
        const externalProvider =
          options.stationViewStore !== undefined
            ? externalTerminalProviderForWorktree(options.stationViewStore, target.worktreeId)
            : undefined;
        if (externalProvider !== undefined) {
          // Keep the overlay open: this is an informational notice, not an open. Closing would flash the
          // toast away (the user only sees it if they reopen the popup fast enough).
          pushLaunchToast(
            `This agent runs in the "${externalProvider}" terminal, which Station can't display. Attach to it from a ${externalProvider} client.`,
            "info",
          );
          return;
        }
        if (landInPane && (await focusExistingSession(prepared.sessionId))) {
          options.store.actions.closeOverlay();
          await acknowledgeTurnReadiness(turnReadiness);
        }
        return;
      }
      const { launchPlan, sessionId, terminalTargetId } = prepared;
      const spawnOptions: StationTerminalSpawnOptions = {
        cwd: target.cwd,
        command: launchPlan.command,
        args: launchPlan.args,
      };
      if (launchPlan.env !== undefined) {
        spawnOptions.env = launchPlan.env;
      }
      registry?.ensure(paneId, spawnOptions);
      options.store.actions.createPane(paneId, { role: "primary-agent" });
      options.store.actions.setPrimaryAgent(paneId, {
        sessionId,
        terminalTargetId,
        harnessProvider: launchPlan.provider,
      });
      if (landInPane) {
        options.store.actions.closeOverlay();
        await acknowledgeTurnReadiness(turnReadiness);
      }
    } finally {
      launchesInFlight.delete(paneId);
    }
  }

  // Station hosts agents itself (worktree.create/fork + a managed launch), never
  // the machine's session.create/fork — those spawn a tmux terminal it can't render.
  type HostedWorktreeLaunch = {
    localId: string;
    projectId: string;
    branch: string;
    harness: ProviderId | undefined;
    command: Extract<StationCommand, { type: "worktree.create" | "worktree.fork" }>;
    verb: "create" | "fork";
  };

  function startHostedWorktreeLaunch(spec: HostedWorktreeLaunch): void {
    const viewStore = options.stationViewStore;
    if (viewStore !== undefined && spec.harness !== undefined) {
      viewStore.setState(
        addPendingCreateSessionRow(viewStore.getState(), {
          localId: spec.localId,
          projectId: spec.projectId,
          branch: spec.branch,
          harnessProvider: spec.harness,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    void runHostedWorktreeLaunch(spec).catch((error) => {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(error);
    });
  }

  async function runHostedWorktreeLaunch(spec: HostedWorktreeLaunch): Promise<void> {
    const observerService = options.observerService;
    if (observerService === undefined) {
      clearPendingCreateRow(spec.localId);
      pushLaunchToast(`No observer connection; cannot ${spec.verb} the session.`);
      return;
    }
    const viewStore = options.stationViewStore;
    if (viewStore === undefined) {
      pushLaunchToast(`The dashboard is not available; cannot ${spec.verb} the session.`);
      return;
    }
    const receipt = await observerService.dispatch(spec.command);
    if (!receipt.accepted) {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(
        receipt.error ?? {
          tag: "ClientObserverError",
          code: `STATION_WORKTREE_${spec.verb.toUpperCase()}_REJECTED`,
          message: `Station could not ${spec.verb} the worktree.`,
        },
      );
      return;
    }
    const completion = await observerService.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(completion.error);
      return;
    }
    // The optimistic row auto-prunes when the worktree reaches the snapshot, which
    // is also when this resolves.
    const row = await waitForWorktreeByBranch(viewStore, spec.projectId, spec.branch);
    if (row === undefined) {
      clearPendingCreateRow(spec.localId);
      pushLaunchToast(
        `${spec.verb === "create" ? "Created" : "Forked"} the worktree, but it didn't appear in time to launch the agent — open it from the dashboard.`,
        "info",
      );
      return;
    }
    const launchTarget: ManagedLaunchTarget = {
      projectId: spec.projectId,
      worktreeId: row.id,
      cwd: row.path,
      background: true,
    };
    if (spec.harness !== undefined) {
      launchTarget.harness = spec.harness;
    }
    await runManagedLaunch(agentWorktreePaneId(row.id), launchTarget);
  }

  function pushLaunchToast(message: string, kind: "info" | "error" = "error"): void {
    options.stationViewStore?.getState().pushToast({ kind, message });
  }

  function pushLaunchError(error: unknown): void {
    options.stationViewStore
      ?.getState()
      .pushToast(safeErrorToNotice(toSafeError(error, { clientLabel: "Station" })));
  }

  // Resolve a worktree row to its terminal *only* when detached or stale (running but not
  // attached anywhere Station can render, so a focus is a no-op). An open terminal or a row
  // with no terminal both fall through to the normal launch/focus path.
  function unreachableTerminalRow(
    worktreeId: string,
  ): { label: string; provider: string; state: string } | undefined {
    const row = options.stationViewStore
      ?.getState()
      .snapshot?.rows.find((candidate) => candidate.id === worktreeId);
    const terminal = row?.terminal;
    if (row === undefined || terminal === undefined) {
      return undefined;
    }
    if (terminal.state !== "detached" && terminal.state !== "stale") {
      return undefined;
    }
    return { label: row.branch, provider: terminal.provider, state: terminal.state };
  }

  async function focusExistingSession(sessionId: string): Promise<boolean> {
    if (options.observerService === undefined) {
      pushLaunchToast("No observer connection; cannot focus the existing agent.");
      return false;
    }
    try {
      const receipt = await options.observerService.dispatch({
        type: "terminal.focus",
        payload: { sessionId },
      });
      if (!receipt.accepted) {
        pushLaunchError(
          receipt.error ?? {
            tag: "ClientObserverError",
            code: "STATION_FOCUS_REJECTED",
            message: "Station could not focus the existing agent.",
          },
        );
        return false;
      }
      const completion = await options.observerService.waitForCommandCompletion(receipt.commandId);
      if (completion.status === "failed") {
        pushLaunchError(completion.error);
        return false;
      }
      return true;
    } catch (error: unknown) {
      pushLaunchError(error);
      return false;
    }
  }

  function readinessForWorktree(
    worktreeId: string,
  ): { sessionId: string; token: string } | undefined {
    const row = options.stationViewStore
      ?.getState()
      .snapshot?.rows.find((candidate) => candidate.id === worktreeId);
    const agent = row?.agent;
    if (
      agent?.state !== "idle" ||
      agent.sessionId === undefined ||
      agent.turnReadiness?.state !== "ready_to_read"
    ) {
      return undefined;
    }
    return {
      sessionId: agent.sessionId,
      token: agent.turnReadiness.token,
    };
  }

  async function acknowledgeTurnReadiness(
    readiness: { sessionId: string; token: string } | undefined,
  ): Promise<void> {
    if (readiness === undefined || options.observerService === undefined) {
      return;
    }
    try {
      const receipt = await options.observerService.dispatch({
        type: "session.acknowledgeTurn",
        payload: readiness,
      });
      if (receipt.accepted) {
        await options.observerService.waitForCommandCompletion(receipt.commandId);
      }
    } catch {
      // Opening the pane succeeded; a best-effort acknowledgement must not turn
      // that successful focus into an error path.
    }
  }

  return {
    handleSequence: (sequence) => {
      const state = options.store.getState();
      const normalized = normalizeSequence(sequence, {
        preserveModifiedEnter: focusedPaneAcceptsModifiedEnter(
          state,
          registry,
          (providerId) =>
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

function providerSupportsModifiedEnterSoftNewline(
  snapshot: StationSnapshot | undefined,
  providerId: ProviderId,
): boolean {
  return (
    snapshot?.sessions.some(
      (session) =>
        session.harness.provider === providerId &&
        session.harness.capabilities.supportsModifiedEnterSoftNewline,
    ) === true
  );
}

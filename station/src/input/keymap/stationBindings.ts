import type { StationClientStateSource } from "@station/client";
import { agentWorktreePaneId, STATION_OVERLAY_ID, type StationState } from "../../state/types.js";
import { isAttentionDismissed, attentionKey } from "../../state/attentionDismissal.js";
import { selectPaneRecord } from "../../state/selectors.js";
import { createStationOverlayLayer } from "../../station/input/stationOverlayLayer.js";
import { routeStationMouse } from "../../station/input/stationMouse.js";
import { rowNeedsUser } from "../../stationButton/status.js";
import type { DashboardActions, DashboardStateSource } from "@station/dashboard-core/runtime";
import { selectDashboardSessionRows } from "@station/dashboard-core/selectors";
import { createKeymapStack, type KeymapLayer, type KeymapStack } from "./keymaps.js";
import type {
  MouseBindings,
  RouteOutcome,
  StationCommandId,
} from "../router.js";
import {
  isPrimaryMouseEvent,
  isRightMouseEvent,
  wheelDirection,
  type StationMouseEvent,
} from "../mouse.js";
import { C0 } from "../../terminal/protocol/syntax.js";
import { ARROW_KEYS } from "../../terminal/protocol/cursorKeys.js";
import type { DashboardScrollController } from "../../station/view/layout/scrollViewport.js";

type StationDashboardInput = {
  state: DashboardStateSource;
  clientState: StationClientStateSource;
  actions: Pick<DashboardActions, "dismissToasts" | "dispatch" | "handleKey" | "pushToast">;
  layout: DashboardScrollController;
};

export const STATION_EXIT_LEGACY = "\x11"; // Ctrl-Q
export const OVERLAY_TOGGLE_LEGACY = "\x0f"; // Ctrl-O
// Pane-management chords. These four control bytes are the only ones safe to
// reserve (not the Tab \x09 / Enter \r / Esc \x1b collision bytes, not the
// readline staples Ctrl-A/E/W/U/K/R), and each has a kitty CSI-u form that
// normalizes back to the legacy byte. Reserving them means a focused shell can
// never receive them — notably SPLIT_RIGHT steals Ctrl-\ (SIGQUIT). Accepted
// tradeoff for keyboard pane control.
export const SPLIT_RIGHT_LEGACY = "\x1c"; // Ctrl-\
export const SPLIT_BELOW_LEGACY = "\x1e"; // Ctrl-^
export const FOCUS_NEXT_LEGACY = "\x1d"; // Ctrl-]
export const CLOSE_PANE_LEGACY = "\x1f"; // Ctrl-_
export const SPACE_LEGACY = " ";

function stationOverlayToggleOutcome(state: StationState): RouteOutcome {
  if (state.input.activeOverlay === STATION_OVERLAY_ID) {
    return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
  }
  return { kind: "overlay-open", overlayId: STATION_OVERLAY_ID };
}

function paneManagementCommandOutcome(
  state: StationState,
  commandId: StationCommandId,
): RouteOutcome {
  if (state.input.activeOverlay === STATION_OVERLAY_ID) {
    return { kind: "swallowed" };
  }
  return { kind: "command", commandId };
}

/**
 * The pre-dashboard placeholder: everything except reserved chords is
 * swallowed so keystrokes cannot reach the hidden shell pane. Kept for
 * callers without a STATION view store (tests of the bare stack); the real
 * overlay layer comes from src/station/input/stationOverlayLayer.ts.
 */
const placeholderOverlayLayer: KeymapLayer<RouteOutcome> = {
  id: "overlay",
  isActive: (state) => state.input.activeOverlay === STATION_OVERLAY_ID,
  bindings: [],
  catchAll: () => ({ kind: "swallowed" }),
};

/**
 * Terminal passthrough consumes every non-empty normalized sequence that is
 * not reserved - control bytes, CSI arrows, and escape included, not just
 * printable text. Empty sequences (key releases, untranslatable keys) never
 * reach the router; normalization consumes them first.
 */
const terminalLayer: KeymapLayer<RouteOutcome> = {
  id: "terminal",
  isActive: (state) => state.input.focus.kind === "pane",
  bindings: [],
  catchAll: (key, state) => {
    const focus = state.input.focus;
    if (focus.kind !== "pane") {
      return { kind: "ignored" };
    }
    return { kind: "terminal-write", paneId: focus.paneId, bytes: key };
  },
};

const welcomeLayer: KeymapLayer<RouteOutcome> = {
  id: "base",
  // Active for both the empty-workspace welcome and the boot intro over restored
  // panes — both park focus on the welcome layer.
  isActive: (state) =>
    state.input.activeOverlay === null && state.input.focus.kind === "welcome",
  bindings: [
    {
      keys: [C0.CarriageReturn, SPACE_LEGACY],
      help: { order: 70, key: "Enter/Sp", description: "open project view on welcome" },
      action: (state) =>
        state.workspace.panes.length > 0
          ? { kind: "welcome-dismiss" }
          : { kind: "overlay-open", overlayId: STATION_OVERLAY_ID },
    },
    {
      // Esc slips past the intro into the sessions underneath; with none there is
      // nothing to dismiss into, so swallow.
      keys: [C0.Escape],
      action: (state) =>
        state.workspace.panes.length > 0
          ? { kind: "welcome-dismiss" }
          : { kind: "swallowed" },
    },
  ],
  catchAll: () => ({ kind: "swallowed" }),
};

const contextMenuLayer: KeymapLayer<RouteOutcome> = {
  id: "context-menu",
  isActive: (state) => state.input.focus.kind === "contextMenu" && state.input.contextMenu !== null,
  bindings: [
    {
      keys: [C0.Escape, OVERLAY_TOGGLE_LEGACY],
      help: { order: 80, key: "Esc/↑↓", description: "context menu close/move" },
      action: () => ({ kind: "context-menu-close" }),
    },
    {
      keys: [ARROW_KEYS.up.normal],
      action: () => ({ kind: "context-menu-move", delta: -1 }),
    },
    {
      keys: [ARROW_KEYS.down.normal],
      action: () => ({ kind: "context-menu-move", delta: 1 }),
    },
    {
      keys: [C0.CarriageReturn, SPACE_LEGACY],
      help: { order: 90, key: "Enter/Sp", description: "context menu select" },
      action: () => ({ kind: "context-menu-select" }),
    },
  ],
  catchAll: (key) => ({ kind: "context-menu-shortcut", key }),
};

/**
 * The island's ↵ jump (C6): active only while the mouse is over the island, a
 * session is asking for the user (and the alert is not dismissed), and no
 * overlay owns the screen — the narrow window where the expanded attention
 * card is showing "↵ or click to focus". Everywhere else Enter falls through to
 * terminal passthrough untouched.
 */
function createStationButtonLayer(
  clientState: StationClientStateSource,
): KeymapLayer<RouteOutcome> {
  const attentionRow = (state: StationState) => {
    const snapshot = clientState.getState().snapshot;
    if (snapshot === undefined) {
      return undefined;
    }
    const now = Date.now();
    return selectDashboardSessionRows(snapshot).find(
      (row) =>
        rowNeedsUser(row.presentation) &&
        !isAttentionDismissed(
          state.feedback.dismissedAttention,
          attentionKey(row.session.id, row.worktree.id),
          now,
        ),
    );
  };
  return {
    id: "station-button",
    isActive: (state) =>
      state.input.stationButtonHover &&
      state.input.activeOverlay === null &&
      attentionRow(state) !== undefined,
    bindings: [
      {
        keys: [C0.CarriageReturn],
        action: (state) => {
          const row = attentionRow(state);
          if (row === undefined) {
            return { kind: "swallowed" };
          }
          // Mirror the island's click: focus the flagged session's live agent
          // pane, else open the dashboard so the user can act on it.
          const paneId = agentWorktreePaneId(row.worktree.id);
          const pane = selectPaneRecord(state, paneId);
          if (
            pane?.role === "primary-agent" &&
            pane.agentIdentity?.sessionId === row.session.id
          ) {
            return { kind: "focus", target: { kind: "pane", paneId } };
          }
          return { kind: "overlay-open", overlayId: STATION_OVERLAY_ID };
        },
      },
    ],
  };
}

const workspaceLayer: KeymapLayer<RouteOutcome> = {
  id: "workspace",
  isActive: () => true,
  bindings: [
    {
      keys: [STATION_EXIT_LEGACY],
      reserved: true,
      help: { order: 20, key: "Ctrl-Q", description: "quit Station" },
      action: () => ({ kind: "command", commandId: "station.exit" }),
    },
    {
      keys: [OVERLAY_TOGGLE_LEGACY],
      reserved: true,
      help: { order: 10, key: "Ctrl-O", description: "open/close project view" },
      action: stationOverlayToggleOutcome,
    },
    // Pane chords stay reserved to bypass terminal passthrough, but the dashboard
    // owns the full canvas and must not mutate the hidden native pane layout.
    {
      keys: [SPLIT_RIGHT_LEGACY],
      reserved: true,
      help: { order: 30, key: "Ctrl-\\", description: "split pane right" },
      action: (state) => paneManagementCommandOutcome(state, "station.splitRight"),
    },
    {
      keys: [SPLIT_BELOW_LEGACY],
      reserved: true,
      help: { order: 40, key: "Ctrl-^", description: "split pane below (Ctrl-6)" },
      action: (state) => paneManagementCommandOutcome(state, "station.splitBelow"),
    },
    {
      keys: [FOCUS_NEXT_LEGACY],
      reserved: true,
      help: { order: 50, key: "Ctrl-]", description: "focus next pane" },
      action: (state) => paneManagementCommandOutcome(state, "station.focusNextPane"),
    },
    {
      keys: [CLOSE_PANE_LEGACY],
      reserved: true,
      help: { order: 60, key: "Ctrl-/", description: "close split pane (Ctrl-_)" },
      action: (state) => paneManagementCommandOutcome(state, "station.closeActivePane"),
    },
  ],
};

/** The registration site: adding a Station chord is one binding here. */
export function createStationKeymap(
  dashboardRuntime?: StationDashboardInput,
): KeymapStack<RouteOutcome> {
  const overlayLayer =
    dashboardRuntime === undefined ? placeholderOverlayLayer : createStationOverlayLayer(dashboardRuntime);
  const layers: KeymapLayer<RouteOutcome>[] = [
    contextMenuLayer,
    overlayLayer,
    terminalLayer,
    workspaceLayer,
    welcomeLayer,
  ];
  if (dashboardRuntime !== undefined) {
    layers.push(createStationButtonLayer(dashboardRuntime.clientState));
  }
  return createKeymapStack(layers);
}

export function stationKeymapHelp() {
  return [workspaceLayer, welcomeLayer, contextMenuLayer]
    .flatMap((layer) =>
      layer.bindings.flatMap((binding) => {
        const help = binding.help;
        return help === undefined ? [] : [{ id: `${layer.id}:${help.order}`, ...help }];
      }),
    )
    .sort((left, right) => left.order - right.order)
    .map(({ id, key, description }) => ({ id, key, description }));
}

/**
 * Header clicks must work while the overlay is open - the mouse path is the
 * documented fallback for terminal setups that never deliver Ctrl-O, so it
 * is not guarded by the overlay itself. Pane clicks do not focus through an
 * active overlay.
 */
export function createStationMouseBindings(
  dashboardRuntime?: StationDashboardInput,
): MouseBindings {
  const anchorFrom = (event: StationMouseEvent) => ({ x: event.x, y: event.y });
  return {
    header: (_target, state, event) => {
      if (state.workspace.panes.length === 0 && state.input.activeOverlay === null) {
        return { kind: "swallowed" };
      }
      if (isRightMouseEvent(event)) {
        return {
          kind: "context-menu-open",
          target: { kind: "header" },
          anchor: anchorFrom(event),
        };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return stationOverlayToggleOutcome(state);
    },
    welcomeOpenProjectView: (_target, state, event) => {
      if (state.input.activeOverlay !== null) {
        return { kind: "swallowed" };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "overlay-open", overlayId: STATION_OVERLAY_ID };
    },
    welcomeContinue: (_target, state, event) => {
      if (state.input.activeOverlay !== null) {
        return { kind: "swallowed" };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "welcome-dismiss" };
    },
    pane: (target, state, event) => {
      if (state.input.activeOverlay !== null || state.input.introVisible) {
        return { kind: "swallowed" };
      }
      const scroll = wheelDirection(event);
      if (scroll !== null) {
        return { kind: "terminal-scroll", paneId: target.paneId, direction: scroll };
      }
      if (isRightMouseEvent(event)) {
        return {
          kind: "context-menu-open",
          target: { kind: "pane", paneId: target.paneId },
          anchor: anchorFrom(event),
        };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "focus", target: { kind: "pane", paneId: target.paneId } };
    },
    // STATION targets resolve in the view's own pure router; close-overlay intents surface as router
    // outcomes so the coordination store keeps owning overlay visibility. Hit-testing and wheel
    // direction are the renderable's job (carried in the target ref) — the router never reads event payloads.
    station: (target, state, event) => {
      if (state.input.activeOverlay !== STATION_OVERLAY_ID || dashboardRuntime === undefined) {
        return { kind: "swallowed" };
      }
      if (
        isRightMouseEvent(event) &&
        target.target.kind !== "screenBackdrop" &&
        target.target.kind !== "sheetBackdrop" &&
        target.target.kind !== "persistentFilterConditionAction" &&
        target.target.kind !== "persistentFilterConditionField" &&
        target.target.kind !== "persistentFilterConditionValue"
      ) {
        return {
          kind: "context-menu-open",
          target: { kind: "station", target: target.target },
          anchor: anchorFrom(event),
        };
      }
      const outcome = routeStationMouse(target.target, event, dashboardRuntime);
      if (outcome.kind === "open-url") {
        return { kind: "open-url", url: outcome.url };
      }
      return { kind: "swallowed" };
    },
    stationBackdrop: (_target, state, event) => {
      if (state.input.activeOverlay !== STATION_OVERLAY_ID) {
        return { kind: "swallowed" };
      }
      if (!isPrimaryMouseEvent(event)) {
        return { kind: "swallowed" };
      }
      return { kind: "overlay-close", overlayId: STATION_OVERLAY_ID };
    },
    contextMenuBackdrop: () => ({ kind: "context-menu-close" }),
    contextMenuItem: (target) => ({ kind: "context-menu-select", itemId: target.itemId }),
    // Hover only moves the highlight; the click (contextMenuItem) selects. Both
    // converge with keyboard arrows on one semantic item identity.
    contextMenuItemHover: (target) => ({ kind: "context-menu-set-active", itemId: target.itemId }),
  };
}

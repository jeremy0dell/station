import { buildContextMenuItems, resolveContextMenuAction } from "../../contextMenu/items.js";
import {
  moveContextMenuActiveItem,
  resolveContextMenuActiveItem,
} from "../../contextMenu/selection.js";
import type { ContextMenuItemId } from "../../contextMenu/types.js";
import { STATION_OVERLAY_ID } from "../../state/types.js";
import { attentionKeysFromSnapshot } from "../../stationButton/status.js";
import type { RouteOutcome } from "../router.js";
import type { StationInputEffects } from "../stationInput.js";

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
      if (outcome.overlayId === STATION_OVERLAY_ID) {
        dismissCurrentAttention(effects);
      }
      effects.store.actions.openOverlay(outcome.overlayId);
      return true;
    case "welcome-dismiss":
      effects.store.actions.dismissWelcomeIntro();
      return true;
    case "overlay-close":
      effects.store.actions.closeOverlay();
      return true;
    case "context-menu-open":
      openContextMenu(outcome.target, outcome.anchor, effects);
      return true;
    case "context-menu-close":
      effects.store.actions.closeContextMenu();
      return true;
    case "context-menu-move":
      moveContextMenuSelection(outcome.delta, effects);
      return true;
    case "context-menu-set-active":
      effects.store.actions.setContextMenuActiveItemId(outcome.itemId);
      return true;
    case "context-menu-select":
      selectContextMenuItem(effects, outcome.itemId);
      return true;
    case "context-menu-shortcut":
      selectContextMenuShortcut(effects, outcome.key);
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

function openContextMenu(
  target: Extract<RouteOutcome, { kind: "context-menu-open" }>["target"],
  anchor: Extract<RouteOutcome, { kind: "context-menu-open" }>["anchor"],
  effects: StationInputEffects,
): void {
  const state = effects.store.getState();
  const firstItem = buildContextMenuItems(
    target,
    state,
    effects.dashboardRuntime?.state.getState(),
    effects.automations,
  )[0];
  effects.store.actions.openContextMenu(target, anchor, firstItem?.id);
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
    effects.dashboardRuntime?.state.getState(),
    effects.automations,
  );
  if (items.length === 0) {
    return;
  }
  const next = moveContextMenuActiveItem(items, menu.activeItemId, delta);
  if (next !== undefined) store.actions.setContextMenuActiveItemId(next);
}

function selectContextMenuShortcut(effects: StationInputEffects, key: string): void {
  const state = effects.store.getState();
  const menu = state.input.contextMenu;
  if (menu === null) return;
  const items = buildContextMenuItems(
    menu.target,
    state,
    effects.dashboardRuntime?.state.getState(),
    effects.automations,
  );
  const item = items.find((candidate) => candidate.shortcut === key);
  if (item !== undefined) selectContextMenuItem(effects, item.id);
}

function selectContextMenuItem(
  effects: StationInputEffects,
  itemId: ContextMenuItemId | undefined,
): void {
  const store = effects.store;
  const state = store.getState();
  const menu = state.input.contextMenu;
  if (menu === null) {
    return;
  }
  const dashboardRuntime = effects.dashboardRuntime;
  const items = buildContextMenuItems(
    menu.target,
    state,
    dashboardRuntime?.state.getState(),
    effects.automations,
  );
  const item =
    itemId === undefined
      ? resolveContextMenuActiveItem(items, menu.activeItemId)
      : items.find((candidate) => candidate.id === itemId);
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
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({
          type: "renameSession.openEdit",
          rowId: action.rowId,
          returnTo: "dashboard",
        });
        dismissCurrentAttention(effects);
        effects.store.actions.openOverlay(STATION_OVERLAY_ID);
      }
      return;
    case "moveToGroup":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({ type: "moveToGroup.open", rowId: action.rowId });
        dismissCurrentAttention(effects);
        effects.store.actions.openOverlay(STATION_OVERLAY_ID);
      }
      return;
    case "removeWorktree":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({ type: "removeWorktree.openConfirm", rowId: action.rowId });
      }
      return;
    case "quickGroup":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({
          type: "sessionGroup.quickCreate",
          projectId: action.projectId,
        });
      }
      return;
    case "newGroup":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({
          type: "createGroup.open",
          projectId: action.projectId,
          returnTo: "projectHeader",
        });
      }
      return;
    case "setProjectDefaultAgent":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({ type: "projectDefaultAgent.open", projectId: action.projectId });
      }
      return;
    case "openProjectSettings":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({ type: "projectSettings.open", projectId: action.projectId });
      }
      return;
    case "groupMenuAction":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({
          type: "sessionGroup.menuAction",
          projectId: action.projectId,
          groupId: action.groupId,
          actionId: action.actionId,
        });
      }
      return;
    case "forkSession":
      if (dashboardRuntime !== undefined) {
        dashboardRuntime.actions.dispatch({
          type: "forkSession.openDetails",
          rowId: action.rowId,
          returnTo: "dashboard",
        });
        dismissCurrentAttention(effects);
        effects.store.actions.openOverlay(STATION_OVERLAY_ID);
      }
      return;
  }
}

/** Quiet the island alert for every session currently asking for the user. */
function dismissCurrentAttention(effects: StationInputEffects): void {
  const snapshot = effects.dashboardRuntime?.state.getState().snapshot;
  effects.store.actions.dismissAttentionKeys(attentionKeysFromSnapshot(snapshot));
}

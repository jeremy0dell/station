import { buildContextMenuItems, resolveContextMenuAction } from "../../contextMenu/items.js";
import { STATION_OVERLAY_ID } from "../../state/types.js";
import {
  openProjectDefaultAgentPicker,
  openProjectSettings,
  openRemoveWorktreeConfirmForRow,
  openRenameEditForRow,
} from "@station/dashboard-core";
import type { RouteOutcome } from "../router.js";
import type { OpenPaneSpawn, StationInputEffects } from "../stationInput.js";

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
    case "open-url":
      effects.openExternalUrl(outcome.url);
      return true;
    case "swallowed":
      return true;
    case "ignored":
      return false;
  }
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

function selectContextMenuItem(effects: StationInputEffects, itemIndex: number | undefined): void {
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
    case "setProjectDefaultAgent":
      if (stationViewStore !== undefined) {
        stationViewStore.setState(
          openProjectDefaultAgentPicker(stationViewStore.getState(), action.projectId),
        );
      }
      return;
    case "openProjectSettings":
      if (stationViewStore !== undefined) {
        stationViewStore.setState(
          openProjectSettings(stationViewStore.getState(), action.projectId),
        );
      }
      return;
  }
}

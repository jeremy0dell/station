import type { ProjectId, SafeError, SessionGroupId } from "@station/contracts";
import { dashboardRowIds } from "../../selectors/dashboardTree.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState, GroupMenuActionId } from "../types.js";
import { focusGroupSettingsControl, openGroupSettings } from "./groupSettings.js";
import { openNewSession } from "./newSession.js";
import { submitQuickSessionInGroup } from "./quickSession.js";

export type GroupMenuInputActionId = GroupMenuActionId | "cancel";

export type GroupMenuItem = {
  readonly id: GroupMenuActionId;
  readonly label: string;
  readonly shortcut: string;
  readonly separatorBefore?: true;
  readonly danger?: true;
};

/** Shared Group-menu order, labels, keyboard shortcuts, and presentation metadata. */
export const GROUP_MENU_ITEMS: readonly GroupMenuItem[] = [
  { id: "quickSession", label: "Quick session", shortcut: "Q" },
  { id: "newSession", label: "New session…", shortcut: "N" },
  {
    id: "settings",
    label: "Group settings…",
    shortcut: "S",
    separatorBefore: true,
  },
  {
    id: "remove",
    label: "Remove Group…",
    shortcut: "R",
    separatorBefore: true,
    danger: true,
  },
] as const;

const GROUP_MENU_ACTIONS = GROUP_MENU_ITEMS.map((item) => item.id);

export const groupMenuScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeGroupMenu,
};

/** Opens the Group menu and anchors safe return to that Group header's menu cell. */
export function openGroupMenu(state: DashboardState, groupId: SessionGroupId): DashboardState {
  const group = state.snapshot?.sessionGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) return state;
  return {
    ...focusGroupMenuCell(state, groupId),
    screen: {
      name: "groupMenu",
      projectId: group.projectId,
      groupId,
      focus: "quickSession",
    },
  };
}

export function handleGroupMenuKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "groupMenu") return { state };
  if (key.escape === true) return handleGroupMenuAction(state, "cancel");
  const direct = GROUP_MENU_ITEMS.find((item) => item.shortcut === key.input);
  if (direct !== undefined) return handleGroupMenuAction(state, direct.id);
  if (key.upArrow === true || key.downArrow === true) {
    return {
      state: {
        ...state,
        screen: {
          ...state.screen,
          focus: cycle(GROUP_MENU_ACTIONS, state.screen.focus, key.upArrow === true ? -1 : 1),
        },
      },
    };
  }
  return isReturnKey(key) ? handleGroupMenuAction(state, state.screen.focus) : { state };
}

/** Activates one anchored Group-menu row through the shared semantic destination resolver. */
export function handleGroupMenuAction(
  state: DashboardState,
  actionId: GroupMenuInputActionId,
): TuiTransition {
  if (state.screen.name !== "groupMenu") return { state };
  if (actionId === "cancel") return { state: closeGroupMenu(state) };
  return activateSessionGroupMenuAction(state, {
    projectId: state.screen.projectId,
    groupId: state.screen.groupId,
    actionId,
  });
}

/** Resolves anchored and native Group-menu actions through one validated dashboard transition. */
export function activateSessionGroupMenuAction(
  state: DashboardState,
  input: {
    projectId: ProjectId;
    groupId: SessionGroupId;
    actionId: GroupMenuActionId;
  },
): TuiTransition {
  if (state.screen.name !== "dashboard" && state.screen.name !== "groupMenu") return { state };
  const group = state.snapshot?.sessionGroups.find((candidate) => candidate.id === input.groupId);
  if (group === undefined) return invalidGroupTransition(state, groupUnavailableError());
  if (group.projectId !== input.projectId) {
    return invalidGroupTransition(state, {
      tag: "CommandValidationError",
      code: "SESSION_GROUP_PROJECT_MISMATCH",
      message: "The selected Group belongs to another project.",
    });
  }

  const dashboardState: DashboardState = {
    ...focusGroupMenuCell(state, input.groupId),
    screen: { name: "dashboard" },
  };
  switch (input.actionId) {
    case "quickSession":
      return submitQuickSessionInGroup(dashboardState, input.groupId, "menu");
    case "newSession":
      if (group.parentGroupId !== undefined) {
        return invalidGroupTransition(dashboardState, {
          tag: "CommandValidationError",
          code: "SESSION_GROUP_NOT_ROOT",
          message: "Nested Groups cannot receive a new session.",
        });
      }
      return openNewSession(dashboardState, {
        projectId: input.projectId,
        groupId: input.groupId,
      });
    case "settings":
      return { state: openGroupSettings(dashboardState, input.groupId, "general") };
    case "remove": {
      const settings = openGroupSettings(dashboardState, input.groupId, "remove");
      return { state: focusGroupSettingsControl(settings, "removeConfirm") };
    }
  }
}

function closeGroupMenu(state: DashboardState): DashboardState {
  if (state.screen.name !== "groupMenu") return state;
  return {
    ...focusGroupMenuCell(state, state.screen.groupId),
    screen: { name: "dashboard" },
  };
}

function focusGroupMenuCell(state: DashboardState, groupId: SessionGroupId): DashboardState {
  return {
    ...state,
    dashboardFocus: { rowId: dashboardRowIds.group(groupId), cellId: "menu" },
  };
}

function invalidGroupTransition(state: DashboardState, error: SafeError): TuiTransition {
  return {
    state: addTuiToast(
      state.screen.name === "groupMenu" ? closeGroupMenu(state) : state,
      safeErrorToToast(error),
    ),
  };
}

function groupUnavailableError(): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_GROUP_NOT_FOUND",
    message: "The selected Group no longer exists.",
  };
}

function cycle<Value>(values: readonly Value[], current: Value, delta: -1 | 1): Value {
  const index = values.indexOf(current);
  return values[(index + delta + values.length) % values.length] ?? current;
}

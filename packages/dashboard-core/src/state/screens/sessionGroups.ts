import { randomUUID } from "node:crypto";
import type { ProjectId } from "@station/contracts";
import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import type { CreateGroupActionId } from "../../components/GroupCreateSheet/content.js";
import { dashboardRowIds, selectDashboardTree } from "../../selectors/dashboardTree.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import { buildCreateSessionGroupCommand } from "../commandBuilders.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type {
  CreateGroupFocus,
  CreateGroupReturnTarget,
  DashboardSnapshotView,
  DashboardState,
  ProjectMenuActionId,
} from "../types.js";
import { openProjectDefaultAgentPicker } from "./projectDefaultAgent.js";
import { openProjectSettings } from "./projectSettings.js";

export type ProjectMenuInputActionId = ProjectMenuActionId | "cancel";

export const projectMenuScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: closeProjectMenu,
};

export const createGroupScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelCreateGroup,
};

const PROJECT_MENU_ACTIONS: readonly ProjectMenuActionId[] = [
  "quickGroup",
  "newGroup",
  "defaultAgent",
  "settings",
];
const CREATE_GROUP_FOCUS: readonly CreateGroupFocus[] = [
  "name",
  "quickSession",
  "create",
  "cancel",
];

/** Opens the Project menu and anchors safe return to that Project header's menu cell. */
export function openProjectMenu(state: DashboardState, projectId: ProjectId): DashboardState {
  if (!hasProject(state, projectId)) return state;
  return {
    ...focusProjectMenuCell(state, projectId),
    screen: { name: "projectMenu", projectId, focus: "quickGroup" },
  };
}

/** Opens Create Group with modality-neutral defaults and an explicit cancellation destination. */
export function openCreateGroup(
  state: DashboardState,
  projectId: ProjectId,
  returnTo: CreateGroupReturnTarget,
): DashboardState {
  if (!hasProject(state, projectId)) return state;
  return {
    ...state,
    screen: {
      name: "createGroup",
      projectId,
      draftName: createEditableTextInputState(),
      quickSession: false,
      focus: "name",
      submitting: false,
      returnTo,
    },
  };
}

export function handleProjectMenuKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectMenu") return { state };
  if (key.escape === true) return handleProjectMenuAction(state, "cancel");
  if (key.input === "G") return handleProjectMenuAction(state, "quickGroup");
  if (key.upArrow === true || key.downArrow === true) {
    return {
      state: {
        ...state,
        screen: {
          ...state.screen,
          focus: cycle(PROJECT_MENU_ACTIONS, state.screen.focus, key.upArrow === true ? -1 : 1),
        },
      },
    };
  }
  return isReturnKey(key) ? handleProjectMenuAction(state, state.screen.focus) : { state };
}

/** Activates one visible Project-menu row through the same transitions used by keyboard input. */
export function handleProjectMenuAction(
  state: DashboardState,
  actionId: ProjectMenuInputActionId,
): TuiTransition {
  if (state.screen.name !== "projectMenu") return { state };
  const { projectId } = state.screen;
  switch (actionId) {
    case "quickGroup":
      return submitQuickGroup(state, { projectId });
    case "newGroup":
      return { state: openCreateGroup(state, projectId, "projectMenu") };
    case "defaultAgent":
      return { state: openProjectDefaultAgentPicker(state, projectId) };
    case "settings":
      return { state: openProjectSettings(state, projectId) };
    case "cancel":
      return { state: closeProjectMenu(state) };
  }
}

export function handleCreateGroupKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "createGroup" || state.screen.submitting) return { state };
  if (key.escape === true) return handleCreateGroupAction(state, "cancel");
  if (key.input === "N") return handleCreateGroupAction(state, "name");
  if (key.input === "Q") return handleCreateGroupAction(state, "quickSession");
  if (key.input === "C") return handleCreateGroupAction(state, "create");
  if (key.upArrow === true || key.downArrow === true) {
    return {
      state: {
        ...state,
        screen: {
          ...state.screen,
          focus: cycle(CREATE_GROUP_FOCUS, state.screen.focus, key.upArrow === true ? -1 : 1),
        },
      },
    };
  }
  if (
    (key.leftArrow === true || key.rightArrow === true) &&
    (state.screen.focus === "create" || state.screen.focus === "cancel")
  ) {
    return handleCreateGroupAction(
      state,
      state.screen.focus === "create" ? "cancel" : "create",
      false,
    );
  }
  if (isReturnKey(key)) return handleCreateGroupAction(state, state.screen.focus);
  if (state.screen.focus !== "name") return { state };
  const intent = editableTextInputIntentForInput({ input: key.input, key });
  if (intent.type !== "edit") return { state };
  return {
    state: {
      ...state,
      screen: {
        ...state.screen,
        draftName: transitionEditableTextInput(state.screen.draftName, intent.action),
      },
    },
  };
}

/** Activates one Create Group control without renderer-specific input behavior. */
export function handleCreateGroupAction(
  state: DashboardState,
  actionId: CreateGroupActionId,
  activate = true,
): TuiTransition {
  if (state.screen.name !== "createGroup" || state.screen.submitting) return { state };
  const screen = state.screen;
  switch (actionId) {
    case "name":
      return { state: { ...state, screen: { ...screen, focus: "name" } } };
    case "quickSession":
      return {
        state: {
          ...state,
          screen: {
            ...screen,
            focus: "quickSession",
            quickSession: activate ? !screen.quickSession : screen.quickSession,
          },
        },
      };
    case "create":
      return activate
        ? submitCreateSessionGroup(state, {
            projectId: screen.projectId,
            name: screen.draftName.value,
            quickSession: screen.quickSession,
          })
        : { state: { ...state, screen: { ...screen, focus: "create" } } };
    case "cancel":
      return activate
        ? { state: cancelCreateGroup(state) }
        : { state: { ...state, screen: { ...screen, focus: "cancel" } } };
  }
}

export type SubmitQuickGroupOptions = {
  projectId?: ProjectId;
  tokenFactory?: () => string;
};

/** Resolves dashboard ownership and emits the shared durable Quick Group operation. */
export function submitQuickGroup(
  state: DashboardState,
  options: SubmitQuickGroupOptions = {},
): TuiTransition {
  const projectId = options.projectId ?? focusedProjectId(state) ?? state.snapshot?.projects[0]?.id;
  if (projectId === undefined) return noProjectTransition(state);
  const name = createQuickGroupName(state.snapshot, projectId, options.tokenFactory);
  return submitCreateSessionGroup(state, { projectId, name, quickSession: true });
}

/** Validates and emits one Group-create operation for sheet, menu, direct, and native callers. */
export function submitCreateSessionGroup(
  state: DashboardState,
  input: { projectId: ProjectId; name: string; quickSession: boolean },
): TuiTransition {
  if (!hasProject(state, input.projectId)) return noProjectTransition(state);
  const name = input.name.trim();
  if (name.length === 0) return { state };
  const submitting =
    state.screen.name === "createGroup"
      ? { ...state, screen: { ...state.screen, submitting: true } }
      : closeTransientProjectSurface(state, input.projectId);
  return {
    state: submitting,
    operations: [
      {
        type: "createSessionGroup",
        projectId: input.projectId,
        name,
        quickSession: input.quickSession,
        previousGroupIds: state.snapshot?.sessionGroups.map((group) => group.id) ?? [],
        command: buildCreateSessionGroupCommand({ projectId: input.projectId, name }),
      },
    ],
  };
}

export function createQuickGroupName(
  snapshot: DashboardSnapshotView | undefined,
  projectId: ProjectId,
  tokenFactory: () => string = createQuickGroupToken,
): string {
  const names = new Set(
    snapshot?.sessionGroups
      .filter((group) => group.projectId === projectId)
      .map((group) => group.name) ?? [],
  );
  while (true) {
    const candidate = `Quick Group ${tokenFactory()}`;
    if (!names.has(candidate)) return candidate;
  }
}

function createQuickGroupToken(): string {
  return randomUUID().replaceAll("-", "").slice(0, 6);
}

function focusedProjectId(state: DashboardState): ProjectId | undefined {
  if (state.snapshot === undefined || state.dashboardFocus === undefined) return undefined;
  const tree = selectDashboardTree(state.snapshot, state, state.screen);
  const row = tree.rowById.get(state.dashboardFocus.rowId);
  if (
    row === undefined ||
    !tree.visibleIndexById.has(row.id) ||
    !row.cells.includes(state.dashboardFocus.cellId)
  ) {
    return undefined;
  }
  switch (row.payload.type) {
    case "projectHeader":
    case "emptyProject":
      return row.payload.project.id;
    case "groupHeader":
      return row.payload.group.projectId;
    case "session":
      return row.payload.row.worktree.projectId;
    case "createLocalRow":
      return row.payload.row.projectId;
    case "groupFrameEnd":
    case "projectGap":
      return undefined;
  }
}

function closeProjectMenu(state: DashboardState): DashboardState {
  if (state.screen.name !== "projectMenu") return state;
  return { ...focusProjectMenuCell(state, state.screen.projectId), screen: { name: "dashboard" } };
}

function cancelCreateGroup(state: DashboardState): DashboardState {
  if (state.screen.name !== "createGroup" || state.screen.submitting) return state;
  const { projectId, returnTo } = state.screen;
  if (returnTo === "projectMenu" && hasProject(state, projectId)) {
    return { ...state, screen: { name: "projectMenu", projectId, focus: "newGroup" } };
  }
  return { ...focusProjectMenuCell(state, projectId), screen: { name: "dashboard" } };
}

function closeTransientProjectSurface(state: DashboardState, projectId: ProjectId): DashboardState {
  return state.screen.name === "projectMenu"
    ? { ...focusProjectMenuCell(state, projectId), screen: { name: "dashboard" } }
    : state;
}

function focusProjectMenuCell(state: DashboardState, projectId: ProjectId): DashboardState {
  return {
    ...state,
    dashboardFocus: { rowId: dashboardRowIds.project(projectId), cellId: "menu" },
  };
}

function hasProject(state: DashboardState, projectId: ProjectId): boolean {
  return state.snapshot?.projects.some((project) => project.id === projectId) === true;
}

function noProjectTransition(state: DashboardState): TuiTransition {
  return {
    state: addTuiToast(
      state,
      safeErrorToToast({
        tag: "CommandValidationError",
        code: "PROJECT_NOT_CONFIGURED",
        message: "No project is configured for a new session.",
        hint: "Add a project to config.toml and run station reconcile.",
      }),
    ),
  };
}

function cycle<Value>(values: readonly Value[], current: Value, delta: -1 | 1): Value {
  const index = values.indexOf(current);
  return values[(index + delta + values.length) % values.length] ?? current;
}

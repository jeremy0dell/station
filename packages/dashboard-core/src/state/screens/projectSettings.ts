import type { ProviderId } from "@station/contracts";
import {
  createEditableTextInputState,
  type EditableTextInputInput,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import {
  choiceValueByKey,
  isSelectionKey,
  selectNewSessionHarnessChoices,
  selectProjectDefaultHarness,
} from "../../selectors/selectors.js";
import {
  buildRemoveProjectCommand,
  buildSetProjectDefaultHarnessCommand,
} from "../commandBuilders.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import { addPendingProjectDefaultHarness } from "../localRows.js";
import type { TuiTransition } from "../transition.js";
import type { ProjectSettingsItemId, TuiState } from "../types.js";

export type ProjectSettingsItem = { id: ProjectSettingsItemId; label: string };

/** List id for the agent detail cursor on the shared selection engine. */
export const PROJECT_SETTINGS_AGENT_LIST_ID = "projectSettingsAgent";

/**
 * Ordered left-list registry for the two-pane Project Settings panel. The panel
 * engine is item-agnostic — extending it is adding an entry here (plus the
 * detail rendering and, for new fields, a persist vertical). The agent detail is
 * the only sub-list wired to the shared selection engine (via the list id above).
 */
export const PROJECT_SETTINGS_ITEMS: readonly ProjectSettingsItem[] = [
  { id: "agent", label: "Default agent" },
  { id: "remove", label: "Remove project" },
];

/** The phrase a user must type to arm the destructive remove action. */
export function removeProjectConfirmPhrase(projectId: string): string {
  return `delete ${projectId}`;
}

export function isRemoveProjectArmed(
  screen: Extract<TuiState["screen"], { name: "projectSettings" }>,
): boolean {
  return screen.removeDraft.value.trim() === removeProjectConfirmPhrase(screen.projectId);
}

type ProjectSettingsScreen = Extract<TuiState["screen"], { name: "projectSettings" }>;

export function openProjectSettings(state: TuiState, projectId: string): TuiState {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return state;
  }
  return {
    ...state,
    screen: {
      name: "projectSettings",
      projectId: project.id,
      focus: "list",
      activeId: "agent",
      removeDraft: createEditableTextInputState(""),
    },
  };
}

/** Mouse: clicking a left item selects it and drops into its detail pane. */
export function focusProjectSettingsItem(state: TuiState, itemId: ProjectSettingsItemId): TuiState {
  if (state.screen.name !== "projectSettings") {
    return state;
  }
  const screen: ProjectSettingsScreen = { ...state.screen, activeId: itemId, focus: "detail" };
  if (itemId !== "remove") {
    screen.removeDraft = createEditableTextInputState("");
  }
  return descend({ ...state, screen }, screen);
}

// Enter the detail pane, seeding the agent cursor to the current effective
// default so ↑↓ start from what is selected and ↵ is immediately meaningful.
function descend(state: TuiState, screen: ProjectSettingsScreen): TuiState {
  if (screen.activeId !== "agent") {
    return state;
  }
  const project = state.snapshot?.projects.find((candidate) => candidate.id === screen.projectId);
  if (project === undefined) {
    return state;
  }
  const selection = new Map(state.selection);
  selection.set(
    PROJECT_SETTINGS_AGENT_LIST_ID,
    selectProjectDefaultHarness(state.localRows, project).harness,
  );
  return { ...state, selection };
}

export function handleProjectSettingsKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "projectSettings") {
    return { state };
  }
  const screen = state.screen;

  // Enum select resolves the active enum item from a slot key regardless of
  // focus, so a right-pane click (which dispatches the row's slot key) selects
  // even when keyboard focus is still the list.
  if (
    screen.activeId === "agent" &&
    key.escape !== true &&
    !isReturnKey(key) &&
    isSelectionKey(key.input)
  ) {
    return selectAgent(state, screen, key);
  }

  if (screen.focus === "list") {
    return handleListKey(state, screen, key);
  }

  if (key.escape === true || key.leftArrow === true) {
    return { state: { ...state, screen: { ...screen, focus: "list" } } };
  }
  if (screen.activeId === "remove") {
    return handleRemoveDetail(state, screen, key);
  }
  return { state };
}

function handleListKey(state: TuiState, screen: ProjectSettingsScreen, key: TuiKey): TuiTransition {
  if (key.escape === true) {
    return { state: toDashboard(state) };
  }
  if (key.upArrow === true) {
    return { state: moveActive(state, screen, -1) };
  }
  if (key.downArrow === true) {
    return { state: moveActive(state, screen, 1) };
  }
  if (key.rightArrow === true || isReturnKey(key)) {
    const detail: ProjectSettingsScreen = { ...screen, focus: "detail" };
    return { state: descend({ ...state, screen: detail }, detail) };
  }
  return { state };
}

// The cross-pane slot handler: resolve the harness from the slot key, then
// commit through the shared path so keyboard slot, right-pane click, and the
// engine cursor all produce the same optimistic change.
function selectAgent(state: TuiState, screen: ProjectSettingsScreen, key: TuiKey): TuiTransition {
  const project = state.snapshot?.projects.find((candidate) => candidate.id === screen.projectId);
  if (state.snapshot === undefined || project === undefined) {
    return { state: toDashboard(state) };
  }
  const option = choiceValueByKey(
    selectNewSessionHarnessChoices(state.snapshot, project),
    key.input,
  );
  return option === undefined ? { state } : commitProjectSettingsAgentById(state, option.id);
}

/**
 * Commit a default-agent choice by id — the single path shared by the engine
 * cursor (↵), the keyboard slot, and the right-pane click. Compares against the
 * effective (optimistic) default, not the snapshot: while a change is in flight
 * the picked agent is what the user sees as current, so re-selecting it is a
 * no-op-and-ascend and picking anything else overrides the pending change.
 */
export function commitProjectSettingsAgentById(
  state: TuiState,
  harness: ProviderId,
): TuiTransition {
  if (state.screen.name !== "projectSettings" || state.snapshot === undefined) {
    return { state };
  }
  const screen = state.screen;
  const project = state.snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  if (project === undefined) {
    return { state: toDashboard(state) };
  }
  const ascended: TuiState = { ...state, screen: { ...screen, focus: "list" } };
  if (harness === selectProjectDefaultHarness(state.localRows, project).harness) {
    return { state: ascended };
  }
  // Move the marker to the picked agent immediately; the runner reverts this if
  // the command fails, and the next snapshot prunes it once the change lands.
  return {
    state: addPendingProjectDefaultHarness(ascended, {
      projectId: project.id,
      harness,
      createdAt: new Date().toISOString(),
    }),
    operations: [
      {
        type: "setProjectDefaultHarness",
        command: buildSetProjectDefaultHarnessCommand({ projectId: project.id, harness }),
      },
    ],
  };
}

function handleRemoveDetail(
  state: TuiState,
  screen: ProjectSettingsScreen,
  key: TuiKey,
): TuiTransition {
  // Armed = the confirm phrase matches; Enter or R then fires the removal.
  if (isRemoveProjectArmed(screen) && (isReturnKey(key) || key.input.toLowerCase() === "r")) {
    const project = state.snapshot?.projects.find((candidate) => candidate.id === screen.projectId);
    if (project === undefined) {
      return { state: toDashboard(state) };
    }
    return {
      state: toDashboard(state),
      operations: [
        { type: "removeProject", command: buildRemoveProjectCommand({ projectId: project.id }) },
      ],
    };
  }
  if (isReturnKey(key)) {
    return { state };
  }
  const intent = editableTextInputIntentForInput({ input: key.input, key: editableKeyFlags(key) });
  if (intent.type === "none") {
    return { state };
  }
  return {
    state: {
      ...state,
      screen: {
        ...screen,
        removeDraft: transitionEditableTextInput(screen.removeDraft, intent.action),
      },
    },
  };
}

function moveActive(state: TuiState, screen: ProjectSettingsScreen, delta: number): TuiState {
  const index = PROJECT_SETTINGS_ITEMS.findIndex((item) => item.id === screen.activeId);
  const next = Math.min(
    Math.max(0, (index === -1 ? 0 : index) + delta),
    PROJECT_SETTINGS_ITEMS.length - 1,
  );
  const item = PROJECT_SETTINGS_ITEMS[next];
  if (item === undefined || item.id === screen.activeId) {
    return state;
  }
  const nextScreen: ProjectSettingsScreen = { ...screen, activeId: item.id };
  // Leaving the remove item drops an abandoned confirm phrase so a forgotten
  // "delete <id>" can't keep the destructive action armed on return.
  if (item.id !== "remove") {
    nextScreen.removeDraft = createEditableTextInputState("");
  }
  return { ...state, screen: nextScreen };
}

function editableKeyFlags(key: TuiKey): EditableTextInputInput["key"] {
  const flags: EditableTextInputInput["key"] = {};
  if (key.ctrl === true) flags.ctrl = true;
  if (key.backspace === true) flags.backspace = true;
  if (key.delete === true) flags.delete = true;
  if (key.leftArrow === true) flags.leftArrow = true;
  if (key.rightArrow === true) flags.rightArrow = true;
  return flags;
}

function toDashboard(state: TuiState): TuiState {
  return { ...state, screen: { name: "dashboard" } };
}

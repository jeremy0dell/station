import type { WorktreeRow } from "@station/contracts";
import { isRunningAgentState } from "@station/contracts";
import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { selectDashboardViewport } from "../../selectors/dashboardViewport.js";
import { choiceValueByKey } from "../../selectors/selectors.js";
import { buildForkSessionCommand } from "../commandBuilders.js";
import { scrollDashboard } from "../dashboardScroll.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";
import { scrollDeltaForKey } from "./dashboard.js";

export type ForkDetailsScreen = Extract<TuiState["screen"], { name: "fork"; step: "details" }>;

type ForkSnapshot = NonNullable<TuiState["snapshot"]>;

export type ForkSessionCreateValidation =
  | {
      ok: true;
      project: ForkSnapshot["projects"][number];
      sourceWorktreeId: ForkDetailsScreen["sourceWorktreeId"];
      branch: string;
      copyDirty: boolean;
    }
  | { ok: false; message: string };

// Single source of truth for fork submit validation, shared by the machine's
// submitFork (inline error) and the native station submit resolver (intercept).
export function validateForkSessionCreate(
  snapshot: ForkSnapshot,
  screen: ForkDetailsScreen,
): ForkSessionCreateValidation {
  const branch = screen.draftBranch.value.trim();
  if (branch.length === 0) {
    return { ok: false, message: "Branch name cannot be empty." };
  }
  // Branch names are unique per project/repo, not globally — only a worktree in
  // the same project can collide.
  if (snapshot.rows.some((row) => row.projectId === screen.projectId && row.branch === branch)) {
    return { ok: false, message: `A worktree on "${branch}" already exists.` };
  }
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  if (project === undefined) {
    return { ok: false, message: "The source project is no longer available." };
  }
  return {
    ok: true,
    project,
    sourceWorktreeId: screen.sourceWorktreeId,
    branch,
    copyDirty: screen.copyDirty,
  };
}

const FOCUS_ORDER = ["branch", "copyDirty", "submit"] as const;

export function handleForkKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "fork") {
    return { state };
  }
  if (state.screen.step === "chooseSlot") {
    return handleChooseSlotKey(state, key);
  }
  return handleDetailsKey(state, key, state.screen);
}

function handleChooseSlotKey(state: TuiState, key: TuiKey): TuiTransition {
  if (key.escape === true) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }

  const scrollDelta = scrollDeltaForKey(key);
  if (scrollDelta !== 0) {
    return { state: scrollDashboard(state, scrollDelta) };
  }

  if (state.snapshot === undefined) {
    return { state };
  }

  const row = choiceValueByKey(
    selectDashboardViewport(state.snapshot, state).rowChoices,
    key.input,
  );
  if (row === undefined) {
    return { state };
  }

  return { state: openForkDetailsForRow(state, row.id) };
}

// Builds the fork details step from a dashboard row. Exported so the context menu can
// open it directly for a clicked row (skipping chooseSlot), like renameSession.
export function openForkDetailsForRow(
  state: TuiState,
  rowId: string,
  returnTo?: "dashboard",
): TuiState {
  if (state.screen.name !== "dashboard" && state.screen.name !== "fork") {
    return state;
  }
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return state;
  }
  const row = snapshot.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined) {
    return state;
  }
  const project = snapshot.projects.find((candidate) => candidate.id === row.projectId);
  if (project === undefined) {
    return state;
  }

  const screen: ForkDetailsScreen = {
    name: "fork",
    step: "details",
    sourceWorktreeId: row.id,
    projectId: row.projectId,
    projectLabel: row.projectLabel,
    sourceBranch: row.branch,
    sourceDirty: row.worktree.dirty === true,
    sourceAgentRunning: isRunningAgentState(row.agent?.state),
    draftBranch: createEditableTextInputState(
      suggestForkBranch(row.branch, snapshot.rows, row.projectId),
    ),
    nameSource: "generated",
    copyDirty: true,
    focus: "branch",
  };
  if (returnTo !== undefined) {
    screen.returnTo = returnTo;
  }
  return { ...state, screen };
}

function suggestForkBranch(
  sourceBranch: string,
  rows: readonly WorktreeRow[],
  projectId: WorktreeRow["projectId"],
): string {
  // Only the source project's branches can collide (uniqueness is per repo).
  const taken = new Set(rows.filter((row) => row.projectId === projectId).map((row) => row.branch));
  const base = `${sourceBranch}-fork`;
  // `taken` is finite, so an unused suffix is always found within taken.size + 1 tries.
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function handleDetailsKey(state: TuiState, key: TuiKey, screen: ForkDetailsScreen): TuiTransition {
  if (key.escape === true) {
    return {
      state: {
        ...state,
        screen:
          screen.returnTo === "dashboard"
            ? { name: "dashboard" }
            : { name: "fork", step: "chooseSlot" },
      },
    };
  }

  if (isReturnKey(key)) {
    return submitFork(state, screen);
  }

  if (key.upArrow === true || key.downArrow === true) {
    return {
      state: {
        ...state,
        screen: { ...screen, focus: cycleFocus(screen.focus, key.upArrow === true) },
      },
    };
  }

  if (screen.focus === "copyDirty") {
    if (key.input === " " || key.leftArrow === true || key.rightArrow === true) {
      return { state: { ...state, screen: { ...screen, copyDirty: !screen.copyDirty } } };
    }
    return { state };
  }

  if (screen.focus === "branch") {
    const intent = editableTextInputIntentForInput({ input: key.input, key });
    if (intent.type !== "edit") {
      return { state };
    }
    return {
      state: {
        ...state,
        screen: {
          ...screen,
          draftBranch: transitionEditableTextInput(screen.draftBranch, intent.action),
          nameSource: "edited",
        },
      },
    };
  }

  return { state };
}

function submitFork(state: TuiState, screen: ForkDetailsScreen): TuiTransition {
  if (state.snapshot === undefined) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }

  const validation = validateForkSessionCreate(state.snapshot, screen);
  if (!validation.ok) {
    return rejected(state, screen, validation.message);
  }

  // Omit base + harness so the observer pins base to the source HEAD and inherits the
  // source worktree's harness; copyDirty is passed explicitly from the toggle.
  const command = buildForkSessionCommand({
    project: validation.project,
    sourceWorktreeId: validation.sourceWorktreeId,
    branch: validation.branch,
    copyDirty: validation.copyDirty,
  });
  if (command.type !== "session.fork") {
    return { state };
  }

  return {
    state: { ...state, screen: { name: "dashboard" } },
    operations: [
      {
        type: "forkSession",
        localId: `fork:${validation.sourceWorktreeId}:${validation.branch}`,
        projectId: screen.projectId,
        sourceWorktreeId: validation.sourceWorktreeId,
        branch: validation.branch,
        command,
      },
    ],
  };
}

// The validation error rides on the spread and clears on the next submit, which re-validates.
function rejected(state: TuiState, screen: ForkDetailsScreen, message: string): TuiTransition {
  return { state: { ...state, screen: { ...screen, validationError: message } } };
}

function cycleFocus(
  focus: ForkDetailsScreen["focus"],
  backwards: boolean,
): ForkDetailsScreen["focus"] {
  const index = FOCUS_ORDER.indexOf(focus);
  const delta = backwards ? -1 : 1;
  const next = (index + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length;
  return FOCUS_ORDER[next] ?? "branch";
}

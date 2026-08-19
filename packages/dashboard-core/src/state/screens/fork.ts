import type { SessionId } from "@station/contracts";
import { isRunningAgentState } from "@station/contracts";
import { stableName } from "@station/runtime";
import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { createNewSessionNameToken } from "../../flows/newSession.js";
import { selectDashboardSessionRow } from "../../selectors/dashboardSessionRows.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardScreenView, DashboardSnapshotView, DashboardState } from "../types.js";
import { handleDashboardRowChoiceKey } from "./rowChoose.js";

export type ForkDetailsScreen = Extract<
  DashboardState["screen"],
  { name: "fork"; step: "details" }
>;
type ForkScreenView = Extract<DashboardScreenView, { name: "fork" }>;
type ForkDetailsScreenView = Extract<ForkScreenView, { step: "details" }>;

export type ForkSessionActionId =
  | "details.name"
  | "details.group"
  | "details.copyDirty"
  | "details.submit";

const forkChooseSlotBehavior = { dashboardHoverEnabled: true };
const forkDetailsBehavior = {
  dashboardHoverEnabled: false,
  clickAway: backFromForkDetails,
};

export function forkScreenBehavior(screen: ForkScreenView) {
  switch (screen.step) {
    case "chooseSlot":
      return forkChooseSlotBehavior;
    case "details":
      return forkDetailsBehavior;
  }
  return assertNever(screen);
}

type ForkWorktreeRowView = DashboardSnapshotView["rows"][number];

/** Refreshes Fork's display-only source Group while preserving an explicit Ungrouped opt-out. */
export function reconcileForkDetailsScreen(
  screen: ForkDetailsScreen,
  snapshot: DashboardSnapshotView,
): ForkDetailsScreen {
  const sourceSession = snapshot.sessions.find(
    (candidate) =>
      candidate.id === screen.sourceSessionId &&
      candidate.projectId === screen.projectId &&
      candidate.worktreeId === screen.sourceWorktreeId,
  );
  const sourceGroup =
    sourceSession === undefined
      ? undefined
      : snapshot.sessionGroups.find(
          (candidate) =>
            candidate.projectId === screen.projectId &&
            candidate.sessionIds.includes(sourceSession.id),
        );
  const next: ForkDetailsScreen = {
    ...screen,
    focus: screen.focus === "group" && sourceGroup === undefined ? "copyDirty" : screen.focus,
  };
  if (sourceGroup === undefined) {
    delete next.sourceGroup;
  } else {
    next.sourceGroup = { id: sourceGroup.id, name: sourceGroup.name };
  }
  return next;
}

export type ForkSessionCreateValidation =
  | {
      ok: true;
      project: DashboardSnapshotView["projects"][number];
      sourceWorktreeId: ForkDetailsScreenView["sourceWorktreeId"];
      title: string;
      branch: string;
      copyDirty: boolean;
      group?: {
        kind: "source";
        sourceSessionId: ForkDetailsScreenView["sourceSessionId"];
        groupId: NonNullable<ForkDetailsScreenView["sourceGroup"]>["id"];
      };
    }
  | { ok: false; message: string };

// Single source of truth for fork submit validation across every input modality.
export function validateForkSessionCreate(
  snapshot: DashboardSnapshotView,
  screen: ForkDetailsScreenView,
): ForkSessionCreateValidation {
  const title = screen.draftTitle.value.trim();
  if (title.length === 0) {
    return { ok: false, message: "Session name cannot be empty." };
  }
  const branch = availableForkBranch(screen.branch, snapshot.rows, screen.projectId);
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  if (project === undefined) {
    return { ok: false, message: "The source project is no longer available." };
  }
  const validation: Extract<ForkSessionCreateValidation, { ok: true }> = {
    ok: true,
    project,
    sourceWorktreeId: screen.sourceWorktreeId,
    title,
    branch,
    copyDirty: screen.copyDirty,
  };
  const sourceSession = snapshot.sessions.find(
    (candidate) =>
      candidate.id === screen.sourceSessionId &&
      candidate.projectId === screen.projectId &&
      candidate.worktreeId === screen.sourceWorktreeId,
  );
  const sourceGroup =
    sourceSession === undefined
      ? undefined
      : snapshot.sessionGroups.find(
          (candidate) =>
            candidate.projectId === screen.projectId &&
            candidate.sessionIds.includes(sourceSession.id),
        );
  if (screen.inheritSourceGroup && sourceSession !== undefined && sourceGroup !== undefined) {
    validation.group = {
      kind: "source",
      sourceSessionId: sourceSession.id,
      groupId: sourceGroup.id,
    };
  }
  return validation;
}

export function handleForkKey(state: DashboardState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "fork") {
    return { state };
  }
  if (state.screen.step === "chooseSlot") {
    if (key.escape === true) {
      return { state: { ...state, screen: { name: "dashboard" } } };
    }
    return handleDashboardRowChoiceKey(state, key, (current, rowId) => ({
      state: openForkDetailsForRow(current, rowId),
    }));
  }
  return handleDetailsKey(state, key, state.screen);
}

/** Applies a visible Fork details action after validating the active screen. */
export function handleForkSessionAction(
  state: DashboardState,
  actionId: ForkSessionActionId,
): TuiTransition {
  if (state.screen.name !== "fork" || state.screen.step !== "details") {
    return { state };
  }
  const screen = state.screen;
  switch (actionId) {
    case "details.name":
      return { state: { ...state, screen: { ...screen, focus: "name" } } };
    case "details.group":
      if (screen.sourceGroup === undefined) return { state };
      return {
        state: {
          ...state,
          screen: {
            ...screen,
            focus: "group",
            inheritSourceGroup: !screen.inheritSourceGroup,
          },
        },
      };
    case "details.copyDirty":
      return {
        state: {
          ...state,
          screen: { ...screen, focus: "copyDirty", copyDirty: !screen.copyDirty },
        },
      };
    case "details.submit":
      return submitFork(state, screen);
  }
}

export type OpenForkDetailsOptions = {
  returnTo?: "dashboard";
  /** Stable injection for deterministic callers; ordinary UI opens mint a fresh branch token. */
  branchToken?: string;
};

// The dashboard action resolver uses this pure transition to skip chooseSlot for context-menu entry.
export function openForkDetailsForRow(
  state: DashboardState,
  rowId: SessionId,
  options: OpenForkDetailsOptions = {},
): DashboardState {
  if (state.screen.name !== "dashboard" && state.screen.name !== "fork") {
    return state;
  }
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    return state;
  }
  const sessionRow = selectDashboardSessionRow(snapshot, rowId);
  if (sessionRow === undefined) {
    return state;
  }
  const row = sessionRow.worktree;
  const project = snapshot.projects.find((candidate) => candidate.id === row.projectId);
  if (project === undefined) {
    return state;
  }

  // A fresh hidden token on each open makes a provider-only Git-ref collision recoverable on retry.
  const branch = availableForkBranch(
    generatedForkBranch(row.branch, options.branchToken ?? createNewSessionNameToken()),
    snapshot.rows,
    row.projectId,
  );
  const screen: ForkDetailsScreen = {
    name: "fork",
    step: "details",
    sourceSessionId: sessionRow.session.id,
    sourceWorktreeId: row.id,
    projectId: row.projectId,
    projectLabel: row.projectLabel,
    sourceBranch: row.branch,
    sourceDirty: row.worktree.dirty === true,
    sourceAgentRunning: snapshot.sessions.some(
      (session) => session.worktreeId === row.id && isRunningAgentState(session.status.value),
    ),
    branch,
    draftTitle: createEditableTextInputState(`${row.branch}-fork`),
    inheritSourceGroup: true,
    copyDirty: true,
    focus: "name",
  };
  const sourceGroup = snapshot.sessionGroups.find((candidate) =>
    candidate.sessionIds.includes(sessionRow.session.id),
  );
  if (sourceGroup !== undefined) {
    screen.sourceGroup = { id: sourceGroup.id, name: sourceGroup.name };
  }
  if (options.returnTo !== undefined) {
    screen.returnTo = options.returnTo;
  }
  return { ...state, screen };
}

function generatedForkBranch(sourceBranch: string, token: string): string {
  return stableName({
    profile: "path-segment",
    display: [sourceBranch, "fork", token],
    unique: [sourceBranch, "fork", token],
  });
}

function availableForkBranch(
  base: string,
  rows: readonly ForkWorktreeRowView[],
  projectId: ForkWorktreeRowView["projectId"],
): string {
  // Only the source project's worktrees can collide in the current snapshot.
  const taken = new Set(rows.filter((row) => row.projectId === projectId).map((row) => row.branch));
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function handleDetailsKey(
  state: DashboardState,
  key: TuiKey,
  screen: ForkDetailsScreen,
): TuiTransition {
  if (key.escape === true) {
    return { state: backFromForkDetails(state) };
  }

  if (isReturnKey(key)) {
    const actionId =
      screen.focus === "group"
        ? "details.group"
        : screen.focus === "copyDirty"
          ? "details.copyDirty"
          : "details.submit";
    return handleForkSessionAction(state, actionId);
  }

  if (key.upArrow === true || key.downArrow === true) {
    return {
      state: {
        ...state,
        screen: { ...screen, focus: cycleFocus(screen, key.upArrow === true) },
      },
    };
  }

  if (screen.focus === "group") {
    return key.input === " " ? handleForkSessionAction(state, "details.group") : { state };
  }

  if (screen.focus === "copyDirty") {
    if (key.input === " " || key.leftArrow === true || key.rightArrow === true) {
      return handleForkSessionAction(state, "details.copyDirty");
    }
    return { state };
  }

  if (screen.focus === "name") {
    const intent = editableTextInputIntentForInput({ input: key.input, key });
    if (intent.type !== "edit") {
      return { state };
    }
    return {
      state: {
        ...state,
        screen: {
          ...screen,
          draftTitle: transitionEditableTextInput(screen.draftTitle, intent.action),
        },
      },
    };
  }

  return { state };
}

function backFromForkDetails(state: DashboardState): DashboardState {
  if (state.screen.name !== "fork" || state.screen.step !== "details") {
    return state;
  }
  return {
    ...state,
    screen:
      state.screen.returnTo === "dashboard"
        ? { name: "dashboard" }
        : { name: "fork", step: "chooseSlot" },
  };
}

function submitFork(state: DashboardState, screen: ForkDetailsScreen): TuiTransition {
  if (state.snapshot === undefined) {
    return { state: { ...state, screen: { name: "dashboard" } } };
  }

  const validation = validateForkSessionCreate(state.snapshot, screen);
  if (!validation.ok) {
    return rejected(state, screen, validation.message);
  }

  const source = state.snapshot.rows.find(
    (candidate) => candidate.id === validation.sourceWorktreeId,
  );
  const inheritedHarness =
    source?.agent?.harness ?? source?.recovery?.provider ?? validation.project.defaults.harness;

  // Close the pure screen before execution so Copy-focused Enter can only toggle,
  // while every actual submit observes the dashboard before its capability starts.
  return {
    state: { ...state, screen: { name: "dashboard" } },
    operations: [
      {
        type: "forkManagedSession",
        localId: `fork:${validation.sourceWorktreeId}:${validation.branch}`,
        project: validation.project,
        sourceWorktreeId: validation.sourceWorktreeId,
        title: validation.title,
        hiddenBranch: validation.branch,
        copyDirty: validation.copyDirty,
        ...(validation.group === undefined ? {} : { group: validation.group }),
        ...(inheritedHarness === undefined ? {} : { inheritedHarness }),
      },
    ],
  };
}

// The validation error rides on the spread and clears on the next submit, which re-validates.
function rejected(
  state: DashboardState,
  screen: ForkDetailsScreen,
  message: string,
): TuiTransition {
  return { state: { ...state, screen: { ...screen, validationError: message } } };
}

function cycleFocus(screen: ForkDetailsScreen, backwards: boolean): ForkDetailsScreen["focus"] {
  const focusOrder: readonly ForkDetailsScreen["focus"][] =
    screen.sourceGroup === undefined
      ? ["name", "copyDirty", "submit"]
      : ["name", "group", "copyDirty", "submit"];
  const index = focusOrder.indexOf(screen.focus);
  const delta = backwards ? -1 : 1;
  const next = (index + delta + focusOrder.length) % focusOrder.length;
  return focusOrder[next] ?? "name";
}

function assertNever(_value: never): never {
  throw new Error("Unhandled Fork screen variant.");
}

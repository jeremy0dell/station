import type { SessionId } from "@station/contracts";
import { isRunningAgentState } from "@station/contracts";
import { stableName } from "@station/runtime";
import {
  createEditableTextInputState,
  editableTextInputIntentForInput,
  transitionEditableTextInput,
} from "../../components/EditableTextInput/editing.js";
import { createNewSessionNameToken } from "../../flows/newSession.js";
import { selectDashboardSessionRow } from "../../selectors/selectors.js";
import { buildForkSessionCommand } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import { isReturnKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardScreenView, DashboardSnapshotView, TuiState } from "../types.js";
import { handleDashboardRowChoiceKey } from "./rowChoose.js";

export type ForkDetailsScreen = Extract<TuiState["screen"], { name: "fork"; step: "details" }>;
type ForkScreenView = Extract<DashboardScreenView, { name: "fork" }>;
type ForkDetailsScreenView = Extract<ForkScreenView, { step: "details" }>;

export type ForkSessionActionId = "details.name" | "details.copyDirty" | "details.submit";

const forkChooseSlotBehavior = {};
const forkDetailsBehavior = { clickAway: backFromForkDetails };

export function forkScreenBehavior(screen: ForkScreenView) {
  switch (screen.step) {
    case "chooseSlot":
      return forkChooseSlotBehavior;
    case "details":
      return forkDetailsBehavior;
  }
  return assertNever(screen);
}

type ForkSnapshotView = DashboardSnapshotView;
type ForkWorktreeRowView = ForkSnapshotView["rows"][number];

export type ForkSessionCreateValidation =
  | {
      ok: true;
      project: ForkSnapshotView["projects"][number];
      sourceWorktreeId: ForkDetailsScreenView["sourceWorktreeId"];
      title: string;
      branch: string;
      copyDirty: boolean;
    }
  | { ok: false; message: string };

// Single source of truth for fork submit validation, shared by the machine's
// submitFork (inline error) and the native station submit resolver (intercept).
export function validateForkSessionCreate(
  snapshot: ForkSnapshotView,
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
  return {
    ok: true,
    project,
    sourceWorktreeId: screen.sourceWorktreeId,
    title,
    branch,
    copyDirty: screen.copyDirty,
  };
}

const FOCUS_ORDER = ["name", "copyDirty", "submit"] as const;

export function handleForkKey(state: TuiState, key: TuiKey): TuiTransition {
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
  state: TuiState,
  actionId: ForkSessionActionId,
): TuiTransition {
  if (state.screen.name !== "fork" || state.screen.step !== "details") {
    return { state };
  }
  const screen = state.screen;
  switch (actionId) {
    case "details.name":
      return { state: { ...state, screen: { ...screen, focus: "name" } } };
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
  state: TuiState,
  rowId: SessionId,
  options: OpenForkDetailsOptions = {},
): TuiState {
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
    copyDirty: true,
    focus: "name",
  };
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

function handleDetailsKey(state: TuiState, key: TuiKey, screen: ForkDetailsScreen): TuiTransition {
  if (key.escape === true) {
    return { state: backFromForkDetails(state) };
  }

  if (isReturnKey(key)) {
    return handleForkSessionAction(
      state,
      screen.focus === "copyDirty" ? "details.copyDirty" : "details.submit",
    );
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

function backFromForkDetails(state: TuiState): TuiState {
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
    title: validation.title,
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
        title: validation.title,
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
  return FOCUS_ORDER[next] ?? "name";
}

function assertNever(_value: never): never {
  throw new Error("Unhandled Fork screen variant.");
}

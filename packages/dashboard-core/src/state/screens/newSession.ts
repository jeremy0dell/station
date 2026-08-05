import {
  createNewSessionNameToken,
  type NewSessionActionId,
  type NewSessionFlowAction,
  type NewSessionInputIntent,
  newSessionActionEnabled,
  newSessionActionForInput,
  newSessionIntentForAction,
  newSessionIntentForInput,
  transitionNewSessionFlow,
  validateNewSessionCreate,
} from "../../flows/newSession.js";
import type { TuiKey } from "../keys.js";
import { seedNewSessionPickerCursor } from "../selection/specs/newSession.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

export const newSessionScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelNewSession,
};

export function handleNewSessionKey(state: TuiState, key: TuiKey): TuiTransition {
  if (state.screen.name !== "newSession") {
    return { state };
  }

  if (state.snapshot === undefined) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  const actionId = newSessionActionForInput(state.screen.flow, {
    input: key.input,
    key,
  });
  if (actionId !== undefined) {
    return handleNewSessionAction(state, actionId);
  }
  const intent = newSessionIntentForInput(state.screen.flow, {
    input: key.input,
    key,
    token: createNewSessionNameToken(),
  });
  return executeNewSessionIntent(state, intent);
}

export function handleNewSessionAction(
  state: TuiState,
  actionId: NewSessionActionId,
): TuiTransition {
  if (state.screen.name !== "newSession") return { state };
  if (!newSessionActionEnabled(state.snapshot, state.screen.flow, actionId)) return { state };
  return executeNewSessionIntent(state, newSessionIntentForAction(state.screen.flow, actionId));
}

function executeNewSessionIntent(state: TuiState, intent: NewSessionInputIntent): TuiTransition {
  if (intent.type === "none") return { state };
  if (intent.type === "submit") return submitNewSession(state);
  if (state.screen.name !== "newSession") return { state };
  const flow = transitionNewSessionFlow(state.screen.flow, intent.action);
  return { state: applyNewSessionFlow(state, flow) };
}

function cancelNewSession(state: TuiState): TuiState {
  if (state.screen.name !== "newSession") {
    return state;
  }
  return applyNewSessionAction(state, { type: "cancel" });
}

function applyNewSessionAction(state: TuiState, action: NewSessionFlowAction): TuiState {
  if (state.screen.name !== "newSession") {
    return state;
  }
  return applyNewSessionFlow(state, transitionNewSessionFlow(state.screen.flow, action));
}

function applyNewSessionFlow(
  state: TuiState,
  flow: Extract<TuiState["screen"], { name: "newSession" }>["flow"] | undefined,
): TuiState {
  return flow === undefined
    ? { ...state, screen: { name: "dashboard" } }
    : seedNewSessionPickerCursor({ ...state, screen: { name: "newSession", flow } });
}

function submitNewSession(state: TuiState): TuiTransition {
  if (state.screen.name !== "newSession" || state.snapshot === undefined) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  const validation = validateNewSessionCreate(state.snapshot, state.screen.flow);
  if (!validation.ok) return { state };

  // Close the pure screen before execution so every renderer observes the dashboard first.
  return {
    state: { ...state, screen: { name: "dashboard" } },
    operations: [
      {
        type: "createManagedSession",
        localId: `create:${validation.project.id}:${createNewSessionNameToken()}`,
        project: validation.project,
        title: validation.title,
        hiddenBranch: validation.branch,
        harness: validation.harnessProvider,
      },
    ],
  };
}

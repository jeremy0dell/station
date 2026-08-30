import type { ProjectId, SafeError, SessionGroupId } from "@station/contracts";
import {
  createNewSessionFlow,
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
import { safeErrorToToast } from "../../services/errors/errors.js";
import type { TuiKey } from "../keys.js";
import { seedNewSessionPickerCursor } from "../selection/specs/newSession.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

export const newSessionScreenBehavior = {
  dashboardHoverEnabled: false,
  clickAway: cancelNewSession,
};

export function openNewSession(
  state: DashboardState,
  options: { projectId?: ProjectId; groupId?: SessionGroupId } = {},
): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }

  const flow = createNewSessionFlow(state.snapshot, createNewSessionNameToken(), options);
  if (flow === undefined) {
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

  return {
    state: {
      ...state,
      screen: { name: "newSession", flow },
    },
  };
}

export function handleNewSessionKey(state: DashboardState, key: TuiKey): TuiTransition {
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
  state: DashboardState,
  actionId: NewSessionActionId,
): TuiTransition {
  if (state.screen.name !== "newSession") return { state };
  if (!newSessionActionEnabled(state.snapshot, state.screen.flow, actionId)) return { state };
  return executeNewSessionIntent(state, newSessionIntentForAction(state.screen.flow, actionId));
}

function executeNewSessionIntent(
  state: DashboardState,
  intent: NewSessionInputIntent,
): TuiTransition {
  if (intent.type === "none") return { state };
  if (intent.type === "submit") return submitNewSession(state);
  if (state.screen.name !== "newSession") return { state };
  const flow = transitionNewSessionFlow(state.screen.flow, intent.action);
  return { state: applyNewSessionFlow(state, flow) };
}

function cancelNewSession(state: DashboardState): DashboardState {
  if (state.screen.name !== "newSession") {
    return state;
  }
  if (state.screen.flow.mode === "review" && state.screen.flow.submissionLocalId !== undefined) {
    return state;
  }
  return applyNewSessionAction(state, { type: "cancel" });
}

function applyNewSessionAction(
  state: DashboardState,
  action: NewSessionFlowAction,
): DashboardState {
  if (state.screen.name !== "newSession") {
    return state;
  }
  return applyNewSessionFlow(state, transitionNewSessionFlow(state.screen.flow, action));
}

function applyNewSessionFlow(
  state: DashboardState,
  flow: Extract<DashboardState["screen"], { name: "newSession" }>["flow"] | undefined,
): DashboardState {
  return flow === undefined
    ? { ...state, screen: { name: "dashboard" } }
    : seedNewSessionPickerCursor({ ...state, screen: { name: "newSession", flow } });
}

function submitNewSession(state: DashboardState): TuiTransition {
  if (
    state.screen.name !== "newSession" ||
    state.screen.flow.mode !== "review" ||
    state.snapshot === undefined
  ) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  const validation = validateNewSessionCreate(state.snapshot, state.screen.flow);
  if (!validation.ok) return { state };

  if (state.screen.flow.submissionLocalId !== undefined) return { state };
  const localId = `create:${validation.project.id}:${createNewSessionNameToken()}`;
  return {
    state: {
      ...state,
      screen: {
        name: "newSession",
        flow: { ...state.screen.flow, submissionLocalId: localId },
      },
    },
    operations: [
      {
        type: "createManagedSession",
        localId,
        project: validation.project,
        title: validation.title,
        hiddenBranch: validation.branch,
        harness: validation.harnessProvider,
        ...(validation.group === undefined ? {} : { group: validation.group }),
      },
    ],
  };
}

export function completeNewSessionSubmission(
  state: DashboardState,
  localId: string,
): DashboardState {
  return state.screen.name === "newSession" &&
    state.screen.flow.mode === "review" &&
    state.screen.flow.submissionLocalId === localId
    ? { ...state, screen: { name: "dashboard" } }
    : state;
}

export function failNewSessionSubmission(
  state: DashboardState,
  localId: string,
  error?: SafeError,
): DashboardState {
  if (
    state.screen.name !== "newSession" ||
    state.screen.flow.mode !== "review" ||
    state.screen.flow.submissionLocalId !== localId
  ) {
    return state;
  }
  const flow = { ...state.screen.flow };
  delete flow.submissionLocalId;
  flow.reviewFocus = error?.code.startsWith("SESSION_GROUP_") === true ? "group" : "create";
  return { ...state, screen: { name: "newSession", flow } };
}

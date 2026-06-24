import {
  createNewSessionNameToken,
  newSessionIntentForInput,
  transitionNewSessionFlow,
  validateNewSessionCreate,
} from "../../flows/newSession.js";
import { safeErrorToToast } from "../../services/errors/errors.js";
import { buildCreateSessionCommand } from "../commandBuilders.js";
import type { TuiKey } from "../keys.js";
import { addPendingCreateSessionRow } from "../localRows.js";
import { addTuiToast } from "../toasts.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

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

  const intent = newSessionIntentForInput(state.screen.flow, {
    input: key.input,
    key,
    token: createNewSessionNameToken(),
  });

  if (intent.type === "none") {
    return { state };
  }

  if (intent.type === "submit") {
    return submitNewSession(state);
  }

  const flow = transitionNewSessionFlow(state.screen.flow, state.snapshot, intent.action);
  if (flow === undefined) {
    return {
      state: {
        ...state,
        screen: { name: "dashboard" },
      },
    };
  }

  return {
    state: {
      ...state,
      screen: { name: "newSession", flow },
    },
  };
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
  if (!validation.ok) {
    return {
      state: addTuiToast(
        {
          ...state,
          screen: { name: "dashboard" },
        },
        safeErrorToToast(validation.error),
      ),
    };
  }

  const branch = validation.branch.trim();
  const command = buildCreateSessionCommand({
    project: validation.project,
    branch,
    harnessProvider: validation.harnessProvider,
  });
  if (command.type !== "session.create") {
    return { state };
  }
  const localId = `create:${validation.project.id}:${createNewSessionNameToken()}`;

  return {
    state: addPendingCreateSessionRow(
      {
        ...state,
        screen: { name: "dashboard" },
      },
      {
        localId,
        projectId: validation.project.id,
        branch,
        harnessProvider: validation.harnessProvider,
        createdAt: new Date().toISOString(),
      },
    ),
    operations: [
      {
        type: "createSession",
        localId,
        projectId: validation.project.id,
        branch,
        harnessProvider: validation.harnessProvider,
        command,
      },
    ],
  };
}

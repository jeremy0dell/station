import type { SetupPlanningIntent } from "../model/intent.js";
import type {
  SetupSessionEvent,
  SetupSessionState,
  SetupSessionTransition,
} from "../model/session.js";
import { emptySetupOperationCheckpoints } from "./checkpoints.js";
import { transitionApplying } from "./transitionApplying.js";
import { transitionBlocked } from "./transitionBlocked.js";
import { transitionEditing } from "./transitionEditing.js";
import { transitionInspecting } from "./transitionInspecting.js";
import { transitionReviewing } from "./transitionReviewing.js";
import { transitionVerifying } from "./transitionVerifying.js";

export function createSetupSessionState(intent: SetupPlanningIntent): SetupSessionState {
  return {
    revision: 0,
    intent,
    checkpoints: emptySetupOperationCheckpoints,
    operationOutcomes: [],
    status: "inspecting",
    inspectionPhase: "initial",
  };
}

/**
 * POLICY
 *
 * Advances one in-memory setup session from normalized evidence and typed operation outcomes without I/O.
 */
export function transitionSetupSession(
  state: SetupSessionState,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.revision !== state.revision) return { state, effects: [] };
  if (event.type === "cancel-requested") {
    if (state.status === "completed" || state.status === "cancelled") return { state, effects: [] };
    return {
      state: {
        revision: state.revision + 1,
        intent: state.intent,
        checkpoints: state.checkpoints,
        operationOutcomes: state.operationOutcomes,
        status: "cancelled",
      },
      effects: [],
    };
  }
  switch (state.status) {
    case "inspecting":
      return transitionInspecting(state, event);
    case "editing":
      return transitionEditing(state, event);
    case "reviewing":
      return transitionReviewing(state, event);
    case "applying":
      return transitionApplying(state, event);
    case "verifying":
      return transitionVerifying(state, event);
    case "blocked":
      return transitionBlocked(state, event);
    case "completed":
    case "cancelled":
      return { state, effects: [] };
  }
}

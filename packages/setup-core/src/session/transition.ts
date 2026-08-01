import type { SetupPlanningIntent } from "../model/intent.js";
import type {
  SetupSessionCancelledState,
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

/** Creates an isolated setup run with no completed-operation history. */
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
  assertKnownSetupEvent(event);
  if (event.type === "cancel-requested") return cancelSetupSession(state);
  if (event.revision !== state.revision) return { state, effects: [] };
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
    default:
      return assertNeverState(state);
  }
}

type SetupCancelledStateBuilder = {
  -readonly [Key in keyof SetupSessionCancelledState]: SetupSessionCancelledState[Key];
};

function cancelSetupSession(state: SetupSessionState): SetupSessionTransition {
  if (state.status === "completed" || state.status === "cancelled") return { state, effects: [] };
  const cancelled: SetupCancelledStateBuilder = {
    revision: state.revision + 1,
    intent: state.intent,
    checkpoints: state.checkpoints,
    operationOutcomes: state.operationOutcomes,
    status: "cancelled",
  };
  if ("plan" in state && state.plan !== undefined) cancelled.plan = state.plan;
  if ("error" in state && state.error !== undefined) cancelled.error = state.error;
  return { state: cancelled, effects: [] };
}

function assertKnownSetupEvent(event: SetupSessionEvent): void {
  switch (event.type) {
    case "inspection-requested":
    case "inspection-completed":
    case "inspection-failed":
    case "review-requested":
    case "preview-requested":
    case "apply-requested":
    case "operation-completed":
    case "operation-failed":
    case "cancel-requested":
      return;
    default:
      assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported setup session event: ${String(value)}`);
}

function assertNeverState(value: never): never {
  throw new Error(`Unsupported setup session state: ${String(value)}`);
}

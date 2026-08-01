import type {
  SetupSessionEvent,
  SetupSessionState,
  SetupSessionTransition,
} from "../model/session.js";
import { planSetup } from "../policy/planSetup.js";

export function transitionVerifying(
  state: Extract<SetupSessionState, { readonly status: "verifying" }>,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type === "inspection-failed") {
    return {
      state: {
        ...state,
        status: "blocked",
        reason: "inspection-failed",
        error: event.error,
        revision: state.revision + 1,
      },
      effects: [],
    };
  }
  if (event.type !== "inspection-completed") return { state, effects: [] };
  const plan = planSetup(event.facts, state.intent);
  return {
    state: {
      revision: state.revision + 1,
      intent: state.intent,
      checkpoints: state.checkpoints,
      operationOutcomes: state.operationOutcomes,
      plan,
      status: "completed",
      result: {
        ...plan.result,
        issues: plan.issues,
        operationOutcomes: state.operationOutcomes,
      },
    },
    effects: [],
  };
}

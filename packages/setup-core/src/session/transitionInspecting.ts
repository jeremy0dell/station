import type {
  SetupSessionEvent,
  SetupSessionState,
  SetupSessionTransition,
} from "../model/session.js";
import { planSetup } from "../policy/planSetup.js";
import { beginConfigWrite, beginTracking } from "./transitionApplying.js";

export function transitionInspecting(
  state: Extract<SetupSessionState, { readonly status: "inspecting" }>,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type === "inspection-requested") {
    return {
      state,
      effects: [{ kind: "inspect", phase: state.inspectionPhase }],
    };
  }
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
  if (state.inspectionPhase === "initial") {
    return {
      state: {
        revision: state.revision + 1,
        intent: state.intent,
        checkpoints: state.checkpoints,
        operationOutcomes: state.operationOutcomes,
        plan,
        status: "editing",
      },
      effects: [],
    };
  }
  return state.inspectionPhase === "after-preflight"
    ? beginConfigWrite(state, plan)
    : beginTracking(state, plan);
}

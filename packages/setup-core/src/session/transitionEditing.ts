import type {
  SetupSessionEditingState,
  SetupSessionEvent,
  SetupSessionTransition,
} from "../model/session.js";
import { beginPreflight } from "./transitionApplying.js";

export function transitionEditing(
  state: SetupSessionEditingState,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type === "intent-replaced") {
    const inspecting = {
      revision: state.revision + 1,
      intent: { ...event.intent, mode: state.intent.mode },
      checkpoints: state.checkpoints,
      operationOutcomes: state.operationOutcomes,
      status: "inspecting" as const,
      inspectionPhase: "initial" as const,
    };
    return { state: inspecting, effects: [{ kind: "inspect", phase: "initial" }] };
  }
  if (event.type === "prepare-requested") return beginPreflight(state, "prepare");
  if (event.type !== "review-requested") return { state, effects: [] };
  return {
    state: { ...state, status: "reviewing", revision: state.revision + 1 },
    effects: [],
  };
}

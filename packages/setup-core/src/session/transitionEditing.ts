import type {
  SetupSessionEditingState,
  SetupSessionEvent,
  SetupSessionTransition,
} from "../model/session.js";

export function transitionEditing(
  state: SetupSessionEditingState,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type !== "review-requested") return { state, effects: [] };
  return {
    state: { ...state, status: "reviewing", revision: state.revision + 1 },
    effects: [],
  };
}

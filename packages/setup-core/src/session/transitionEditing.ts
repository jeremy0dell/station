import type { SetupSessionEvent, SetupSessionTransition } from "../model/session.js";

export function transitionEditing(
  state: Extract<SetupSessionTransition["state"], { readonly status: "editing" }>,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type !== "review-requested") return { state, effects: [] };
  return {
    state: { ...state, status: "reviewing", revision: state.revision + 1 },
    effects: [],
  };
}

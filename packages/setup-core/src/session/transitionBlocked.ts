import type {
  SetupSessionEvent,
  SetupSessionState,
  SetupSessionTransition,
} from "../model/session.js";

export function transitionBlocked(
  state: Extract<SetupSessionState, { readonly status: "blocked" }>,
  _event: SetupSessionEvent,
): SetupSessionTransition {
  return { state, effects: [] };
}

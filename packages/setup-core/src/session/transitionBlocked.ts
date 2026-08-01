import type {
  SetupSessionBlockedState,
  SetupSessionEvent,
  SetupSessionTransition,
} from "../model/session.js";

export function transitionBlocked(
  state: SetupSessionBlockedState,
  _event: SetupSessionEvent,
): SetupSessionTransition {
  return { state, effects: [] };
}

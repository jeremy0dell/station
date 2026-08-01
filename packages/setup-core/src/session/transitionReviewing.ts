import type { SetupSessionEvent, SetupSessionTransition } from "../model/session.js";
import { beginPreflight } from "./transitionApplying.js";

export function transitionReviewing(
  state: Extract<SetupSessionTransition["state"], { readonly status: "reviewing" }>,
  event: SetupSessionEvent,
): SetupSessionTransition {
  if (event.type === "preview-requested") {
    return {
      state: { ...state, status: "verifying", revision: state.revision + 1 },
      effects: [{ kind: "inspect", phase: "final" }],
    };
  }
  if (event.type !== "apply-requested") return { state, effects: [] };
  if (state.plan.selection.outcome !== "selected") {
    return {
      state: {
        ...state,
        status: "blocked",
        reason: "selection-unresolved",
        checkpoints: state.checkpoints,
        revision: state.revision + 1,
      },
      effects: [],
    };
  }
  return beginPreflight(state);
}

import type { NewSessionFlowStateView } from "../../flows/newSession.js";
import { SELECTION_KEYS } from "../../selectors/selectors.js";

export const MAX_PICKER_OPTIONS = SELECTION_KEYS.length;

export function newSessionContentRowCount(
  state: NewSessionFlowStateView,
  optionCount: number,
): number {
  if (state.mode === "pickProject" || state.mode === "pickAgent") {
    return Math.min(optionCount, MAX_PICKER_OPTIONS) + 4;
  }
  if (state.mode === "editName") {
    // Project context + Name input + Save + Back + contextual helper.
    return 6;
  }
  // Project/Name/Agent interactive rows + primary Create action + contextual helper.
  return 6;
}

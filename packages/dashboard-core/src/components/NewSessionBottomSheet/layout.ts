import type { NewSessionFlowState } from "../../flows/newSession.js";
import { SELECTION_KEYS } from "../../selectors/selectors.js";

export const MAX_PICKER_OPTIONS = SELECTION_KEYS.length;

export function newSessionContentRowCount(state: NewSessionFlowState, optionCount: number): number {
  if (state.mode === "pickProject" || state.mode === "pickAgent") {
    return Math.min(optionCount, MAX_PICKER_OPTIONS) + 4;
  }
  if (state.mode === "editName") {
    return 6;
  }
  // review: leading blank + Project/Name/Agent + blank + Create row + footer.
  return 8;
}

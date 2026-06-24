import type { NewSessionFlowState } from "../../flows/newSession.js";
import { SELECTION_KEYS } from "../../selectors/selectors.js";
import { type BottomSheetFrameLayout, bottomSheetFrameLayout } from "../BottomSheetFrame/layout.js";

export const MAX_PICKER_OPTIONS = SELECTION_KEYS.length;

export type NewSessionBottomSheetLayoutInput = {
  columns: number;
  rows: number;
  state: NewSessionFlowState;
  optionCount: number;
};

export type NewSessionBottomSheetLayout = BottomSheetFrameLayout;

export function newSessionBottomSheetLayout(
  input: NewSessionBottomSheetLayoutInput,
): NewSessionBottomSheetLayout {
  return bottomSheetFrameLayout({
    columns: input.columns,
    rows: input.rows,
    contentRows: newSessionContentRowCount(input.state, input.optionCount),
  });
}

export function newSessionContentRowCount(state: NewSessionFlowState, optionCount: number): number {
  if (state.mode === "pickProject" || state.mode === "pickAgent") {
    return Math.min(optionCount, MAX_PICKER_OPTIONS) + 4;
  }
  if (state.mode === "editName") {
    return 6;
  }
  return 7;
}

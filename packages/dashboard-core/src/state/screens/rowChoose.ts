import type { SessionId } from "@station/contracts";
import { selectDashboardViewport } from "../../selectors/dashboardViewport.js";
import { choiceValueByKey } from "../../selectors/selectors.js";
import { focusedSelectableRow, moveDashboardFocus } from "../dashboardFocus.js";
import { scrollDashboard } from "../dashboardScroll.js";
import { isSlotKey } from "../keymap.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import type { TuiTransition } from "../transition.js";
import type { TuiState } from "../types.js";

/**
 * The shared choose-a-dashboard-row step behind remove/rename/fork. Arrows move
 * the dashboard cursor (with follow-scroll), ↵ commits the focused row, and a
 * slot key commits the viewport row — all three converge on `commit(state, id)`.
 * Esc is handled by each screen's own reducer. Reuses the dashboard's cursor
 * rather than the generic engine because these list the full dashboard row
 * stream (viewport-windowed slots, follow-scroll) the engine deliberately omits.
 */
export function handleDashboardRowChoiceKey(
  state: TuiState,
  key: TuiKey,
  commit: (state: TuiState, rowId: SessionId) => TuiTransition,
): TuiTransition {
  if (key.upArrow === true) {
    return { state: moveDashboardFocus(state, -1) };
  }
  if (key.downArrow === true) {
    return { state: moveDashboardFocus(state, 1) };
  }
  // The wheel still pans the viewport without moving the cursor.
  if (key.mouseScroll !== undefined) {
    return { state: scrollDashboard(state, key.mouseScroll === "up" ? -1 : 1) };
  }
  if (state.snapshot === undefined) {
    return { state };
  }
  if (isReturnKey(key)) {
    const row = focusedSelectableRow(state);
    return row === undefined ? { state } : commit(state, row.id);
  }
  if (isSlotKey(key)) {
    const row = choiceValueByKey(
      selectDashboardViewport(state.snapshot, state).rowChoices,
      key.input,
    );
    return row === undefined ? { state } : commit(state, row.id);
  }
  return { state };
}

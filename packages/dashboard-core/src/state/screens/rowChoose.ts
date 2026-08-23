import type { SessionId } from "@station/contracts";
import { selectDashboardSlots } from "../../selectors/dashboardSlots.js";
import { choiceValueByKey } from "../../selectors/selectors.js";
import { focusedChooserSession, moveDashboardChooserCursor } from "../dashboardFocus.js";
import { isSlotKey } from "../keymap.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import type { DashboardVisibleRowsSource } from "../layoutVisibility.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

/**
 * The shared choose-a-dashboard-row step behind remove/rename/fork. Arrows move
 * the session-only cursor, ↵ commits the focused row, and a slot key commits a
 * renderer-visible row — all three converge on `commit(state, id)`.
 * Esc is handled by each screen's own reducer. Reuses the dashboard's cursor
 * rather than the generic engine because these list the full dashboard row
 * stream while the renderer supplies the semantic identities intersecting its viewport.
 */
export function handleDashboardRowChoiceKey(
  state: DashboardState,
  key: TuiKey,
  commit: (state: DashboardState, rowId: SessionId) => TuiTransition,
  visibleRows?: DashboardVisibleRowsSource,
): TuiTransition {
  if (key.upArrow === true) {
    return { state: moveDashboardChooserCursor(state, -1, visibleRows?.visibleRowIds()) };
  }
  if (key.downArrow === true) {
    return { state: moveDashboardChooserCursor(state, 1, visibleRows?.visibleRowIds()) };
  }
  if (key.mouseScroll !== undefined) return { state };
  if (state.snapshot === undefined) {
    return { state };
  }
  if (isReturnKey(key)) {
    const row = focusedChooserSession(state);
    return row === undefined ? { state } : commit(state, row.id);
  }
  if (isSlotKey(key)) {
    const row = choiceValueByKey(
      selectDashboardSlots(state.snapshot, state, state.screen, visibleRows?.visibleRowIds())
        .rowChoices,
      key.input,
    );
    return row === undefined ? { state } : commit(state, row.id);
  }
  return { state };
}

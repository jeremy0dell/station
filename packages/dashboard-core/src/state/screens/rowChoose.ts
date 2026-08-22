import type { SessionId } from "@station/contracts";
import { dashboardShortcutValue } from "../../selectors/dashboardShortcuts.js";
import { selectDashboardViewport } from "../../selectors/dashboardViewport.js";
import { focusedChooserSession, moveDashboardChooserCursor } from "../dashboardFocus.js";
import { scrollDashboard } from "../dashboardScroll.js";
import { isSlotKey } from "../keymap.js";
import { isReturnKey, type TuiKey } from "../keys.js";
import { handleShortcutCodeInputKey } from "../shortcutInput.js";
import type { TuiTransition } from "../transition.js";
import type { DashboardState } from "../types.js";

/**
 * The shared choose-a-dashboard-row step behind remove/rename/fork. Arrows move
 * the session-only cursor (with follow-scroll), ↵ commits the focused row, and a
 * logical shortcut commits its global projected row — all three converge on `commit(state, id)`.
 * Esc is handled by each screen's own reducer. Reuses the dashboard's cursor
 * rather than the generic engine because these list the full dashboard row
 * stream (global shortcut identities, follow-scroll) the engine deliberately omits.
 */
export function handleDashboardRowChoiceKey(
  state: DashboardState,
  key: TuiKey,
  commit: (state: DashboardState, rowId: SessionId) => TuiTransition,
): TuiTransition {
  const shortcutInput = handleShortcutCodeInputKey(state, key, { armOnBacktick: true });
  if (shortcutInput.kind === "handled") {
    return { state: shortcutInput.state };
  }
  if (shortcutInput.kind === "submit") {
    return commitDashboardShortcut(shortcutInput.state, shortcutInput.code, commit);
  }
  if (key.upArrow === true) {
    return { state: moveDashboardChooserCursor(state, -1) };
  }
  if (key.downArrow === true) {
    return { state: moveDashboardChooserCursor(state, 1) };
  }
  // The wheel still pans the viewport without moving the cursor.
  if (key.mouseScroll !== undefined) {
    return { state: scrollDashboard(state, key.mouseScroll === "up" ? -1 : 1) };
  }
  if (state.snapshot === undefined) {
    return { state };
  }
  if (isReturnKey(key)) {
    const row = focusedChooserSession(state);
    return row === undefined ? { state } : commit(state, row.id);
  }
  if (isSlotKey(key)) {
    return commitDashboardShortcut(state, key.input, commit);
  }
  return { state };
}

function commitDashboardShortcut(
  state: DashboardState,
  code: string,
  commit: (state: DashboardState, rowId: SessionId) => TuiTransition,
): TuiTransition {
  if (state.snapshot === undefined) {
    return { state };
  }
  const row = dashboardShortcutValue(
    selectDashboardViewport(state.snapshot, state).rowChoices,
    code,
  );
  return row === undefined ? { state } : commit(state, row.id);
}

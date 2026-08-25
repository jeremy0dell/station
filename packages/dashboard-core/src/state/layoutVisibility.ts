import type { DashboardRowId } from "../selectors/dashboardTree.js";

/**
 * Renderer-reported semantic visibility. Implementations may use physical geometry internally,
 * but dashboard-core receives only stable row identities and never terminal coordinates.
 */
export type DashboardVisibleRowsSource = {
  visibleRowIds(): readonly DashboardRowId[] | undefined;
};

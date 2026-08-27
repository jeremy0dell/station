// The title/widgets live on the frame's top border row, outside these rows.
export const DASHBOARD_FIXED_ROW_HEIGHTS = {
  topSpacer: 1,
  fleetBar: 1,
  topDivider: 1,
  topScrollIndicator: 1,
  bottomScrollIndicator: 1,
  bottomDivider: 1,
  footer: 1,
} as const;

export type ClampDashboardScrollOffsetInput = {
  bodyRows: number;
  itemCount: number;
  scrollOffset: number;
};

export function dashboardFixedRows(): number {
  return Object.values(DASHBOARD_FIXED_ROW_HEIGHTS).reduce((total, rows) => total + rows, 0);
}

/** Shared absolute offset from the dashboard surface to its first projected tree row. */
export function dashboardBodyTop(): number {
  return dashboardScrollGutterChrome({ hasFleetBar: true }).top;
}

/** Chrome rows above/below the body column, matching DashboardView's child list. */
export function dashboardScrollGutterChrome(options: { hasFleetBar: boolean }): {
  top: number;
  bottom: number;
} {
  const top =
    DASHBOARD_FIXED_ROW_HEIGHTS.topSpacer +
    (options.hasFleetBar ? DASHBOARD_FIXED_ROW_HEIGHTS.fleetBar : 0) +
    DASHBOARD_FIXED_ROW_HEIGHTS.topDivider +
    DASHBOARD_FIXED_ROW_HEIGHTS.topScrollIndicator;
  const bottom =
    DASHBOARD_FIXED_ROW_HEIGHTS.bottomScrollIndicator + DASHBOARD_FIXED_ROW_HEIGHTS.bottomDivider;
  return { top, bottom };
}

export function dashboardBodyRows(totalRows: number): number {
  return Math.max(1, Math.floor(totalRows) - dashboardFixedRows());
}

export function clampDashboardScrollOffset(input: ClampDashboardScrollOffsetInput): number {
  const bodyRows = Math.max(1, Math.floor(input.bodyRows));
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const requested = Number.isFinite(input.scrollOffset) ? Math.floor(input.scrollOffset) : 0;
  const maxOffset = Math.max(0, itemCount - bodyRows);
  return Math.min(Math.max(0, requested), maxOffset);
}

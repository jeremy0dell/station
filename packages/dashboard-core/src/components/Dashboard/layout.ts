export const DASHBOARD_FIXED_ROW_HEIGHTS = {
  header: 1,
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

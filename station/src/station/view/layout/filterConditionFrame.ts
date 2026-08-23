import { cellWidth } from "@station/dashboard-core/selectors";

export type FilterConditionFrame = {
  readonly width: number;
  readonly innerWidth: number;
};

const MIN_PANEL_WIDTH = 34;
const PANEL_MARGIN_RIGHT = 2;

/** OpenTUI boundary for a condition popover's terminal-cell width. */
export function filterConditionFrame(
  columns: number,
  labels: readonly string[],
): FilterConditionFrame {
  const availableWidth = Math.max(1, Math.floor(columns) - PANEL_MARGIN_RIGHT);
  const intrinsicWidth = Math.max(
    MIN_PANEL_WIDTH,
    Math.max(0, ...labels.map((label) => cellWidth(label))) + 12,
  );
  const width = Math.min(availableWidth, intrinsicWidth);
  return { width, innerWidth: Math.max(1, width - 2) };
}

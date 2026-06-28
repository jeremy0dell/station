export type ProjectSettingsPanelLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Inside the border: usable width and height for the two columns + footer. */
  innerWidth: number;
  contentHeight: number;
  /** The two-column split of `innerWidth` (with one gap column between them). */
  leftWidth: number;
  rightWidth: number;
};

const MIN_PANEL_WIDTH = 46;
const MAX_PANEL_WIDTH = 88;
const MIN_PANEL_HEIGHT = 11;
const MAX_PANEL_HEIGHT = 20;
const SCREEN_MARGIN_X = 6;
const SCREEN_MARGIN_Y = 4;
const LEFT_COLUMN_RATIO = 0.4;
const LEFT_COLUMN_MIN = 16;
const LEFT_COLUMN_MAX = 26;

export function projectSettingsPanelLayout(
  columns: number,
  rows: number,
): ProjectSettingsPanelLayout {
  const width = Math.min(Math.max(MIN_PANEL_WIDTH, columns - SCREEN_MARGIN_X), MAX_PANEL_WIDTH);
  const height = Math.min(Math.max(MIN_PANEL_HEIGHT, rows - SCREEN_MARGIN_Y), MAX_PANEL_HEIGHT);
  // Frame chrome consumed by the border (2) plus the title and footer rows (2).
  const innerWidth = width - 2;
  const contentHeight = Math.max(1, height - 4);
  const leftWidth = Math.min(
    LEFT_COLUMN_MAX,
    Math.max(LEFT_COLUMN_MIN, Math.floor(innerWidth * LEFT_COLUMN_RATIO)),
  );
  // One spacer column sits between the left list and the right detail pane.
  const rightWidth = Math.max(1, innerWidth - leftWidth - 1);
  return {
    left: Math.max(0, Math.floor((columns - width) / 2)),
    top: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height,
    innerWidth,
    contentHeight,
    leftWidth,
    rightWidth,
  };
}

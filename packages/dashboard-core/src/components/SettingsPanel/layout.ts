export type SettingsPanelPaneMode = "split" | "single";

export type SettingsPanelLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  paneMode: SettingsPanelPaneMode;
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
const SINGLE_PANE_MAX_INNER_WIDTH = 53;

/** Shared responsive list/detail settings geometry, bounded to the terminal viewport. */
export function settingsPanelLayout(columns: number, rows: number): SettingsPanelLayout {
  const availableColumns = Math.max(3, columns);
  const availableRows = Math.max(5, rows);
  const width = Math.min(
    availableColumns,
    Math.min(Math.max(MIN_PANEL_WIDTH, columns - SCREEN_MARGIN_X), MAX_PANEL_WIDTH),
  );
  const height = Math.min(
    availableRows,
    Math.min(Math.max(MIN_PANEL_HEIGHT, rows - SCREEN_MARGIN_Y), MAX_PANEL_HEIGHT),
  );
  const innerWidth = Math.max(1, width - 2);
  const contentHeight = Math.max(1, height - 4);
  const maximumLeftWidth = Math.max(1, innerWidth - 2);
  const leftWidth = Math.min(
    maximumLeftWidth,
    LEFT_COLUMN_MAX,
    Math.max(LEFT_COLUMN_MIN, Math.floor(innerWidth * LEFT_COLUMN_RATIO)),
  );
  const rightWidth = Math.max(1, innerWidth - leftWidth - 1);
  return {
    left: Math.max(0, Math.floor((columns - width) / 2)),
    top: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height,
    paneMode: innerWidth <= SINGLE_PANE_MAX_INNER_WIDTH ? "single" : "split",
    innerWidth,
    contentHeight,
    leftWidth,
    rightWidth,
  };
}

export type SettingsPanelFrame = {
  readonly width: number;
  readonly height: number;
  readonly innerWidth: number;
  readonly paneMode: "split" | "single";
  readonly listWidth: number;
  readonly detailWidth: number;
};

const MIN_PANEL_WIDTH = 46;
const MAX_PANEL_WIDTH = 88;
const SCREEN_MARGIN_X = 6;
const LIST_COLUMN_RATIO = 0.4;
const LIST_COLUMN_MIN = 16;
const LIST_COLUMN_MAX = 26;
const SINGLE_PANE_MAX_INNER_WIDTH = 53;
const PREFERRED_PANEL_HEIGHT = 20;

/** OpenTUI boundary for responsive settings dimensions and pane composition. */
export function settingsPanelFrame(columns: number, rows: number): SettingsPanelFrame {
  const availableColumns = Math.max(1, columns);
  const availableRows = Math.max(1, rows);
  const width = Math.min(
    availableColumns,
    Math.min(Math.max(MIN_PANEL_WIDTH, columns - SCREEN_MARGIN_X), MAX_PANEL_WIDTH),
  );
  const innerWidth = Math.max(1, width - 2);
  const maximumListWidth = Math.max(1, innerWidth - 2);
  const listWidth = Math.min(
    maximumListWidth,
    LIST_COLUMN_MAX,
    Math.max(LIST_COLUMN_MIN, Math.floor(innerWidth * LIST_COLUMN_RATIO)),
  );
  return {
    width,
    height: Math.min(availableRows, PREFERRED_PANEL_HEIGHT),
    innerWidth,
    paneMode: innerWidth <= SINGLE_PANE_MAX_INNER_WIDTH ? "single" : "split",
    listWidth,
    detailWidth: Math.max(1, innerWidth - listWidth - 1),
  };
}

export type WidgetSettingsFrame = {
  readonly width: number;
  readonly height: number;
  readonly innerWidth: number;
};

const WIDGET_PANEL_WIDTH = 48;
const WIDGET_PANEL_MIN_WIDTH = 28;

export function widgetSettingsFrame(columns: number, rows: number): WidgetSettingsFrame {
  const width = Math.min(
    Math.max(1, columns),
    Math.min(WIDGET_PANEL_WIDTH, Math.max(WIDGET_PANEL_MIN_WIDTH, columns - 2)),
  );
  return {
    width,
    height: Math.min(Math.max(1, rows), PREFERRED_PANEL_HEIGHT),
    innerWidth: Math.max(1, width - 2),
  };
}

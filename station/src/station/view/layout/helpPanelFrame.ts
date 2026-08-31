export type HelpPanelFrame = {
  readonly width: number | `${number}%`;
  readonly height: number;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly effectiveWidth: number;
};

export const HELP_PANEL_MAX_WIDTH = 64;

const PREFERRED_HELP_HEIGHT = 20;
const HELP_PANEL_WIDTH_RATIO = 0.9;

/** OpenTUI boundary for the bounded Help panel; semantic entries never observe cell geometry. */
export function helpPanelFrame(columns: number, rows: number): HelpPanelFrame {
  const availableColumns = Math.max(1, Math.floor(columns));
  const availableRows = Math.max(1, Math.floor(rows));
  const effectiveWidth = availableColumns <= 1
    ? 1
    : Math.max(
        1,
        Math.min(
          HELP_PANEL_MAX_WIDTH,
          Math.floor(availableColumns * HELP_PANEL_WIDTH_RATIO),
        ),
      );
  return {
    width: availableColumns <= 1 ? 1 : "90%",
    height: Math.min(availableRows, PREFERRED_HELP_HEIGHT),
    overlayWidth: availableColumns,
    overlayHeight: availableRows,
    effectiveWidth,
  };
}

export type HelpPanelFrame = {
  readonly width: number | `${number}%`;
  readonly height: number;
};

const PREFERRED_HELP_HEIGHT = 20;

/** OpenTUI boundary for the bounded Help panel; semantic entries never observe cell geometry. */
export function helpPanelFrame(columns: number, rows: number): HelpPanelFrame {
  const availableColumns = Math.max(1, Math.floor(columns));
  const availableRows = Math.max(1, Math.floor(rows));
  return {
    width: availableColumns <= 1 ? 1 : "90%",
    height: Math.min(availableRows, PREFERRED_HELP_HEIGHT),
  };
}

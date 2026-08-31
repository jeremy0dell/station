export type BottomSheetFrame = {
  readonly width: number;
  readonly height: number;
  readonly contentWidth: number;
};

const PREFERRED_SHEET_HEIGHT = 12;

/** Width for the compact bottom-sheet confirm dialogs (capped at 46 columns). */
export function compactSheetWidth(columns: number): number {
  return Math.min(Math.max(1, Math.floor(columns)), 46);
}

/**
 * OpenTUI boundary for the stable bottom-sheet box.
 * Semantic sheet state never observes these terminal-cell dimensions.
 */
export function bottomSheetFrame(columns: number, rows: number, requestedWidth?: number): BottomSheetFrame {
  const availableColumns = Math.max(1, Math.floor(columns));
  const availableRows = Math.max(1, Math.floor(rows));
  const width = Math.max(
    1,
    Math.min(availableColumns, Math.floor(requestedWidth ?? availableColumns)),
  );
  return {
    width,
    height: Math.min(availableRows, PREFERRED_SHEET_HEIGHT),
    contentWidth: bottomSheetContentWidth(width),
  };
}

/** Renderer-boundary width available inside the frame's two border cells. */
export function bottomSheetContentWidth(columns: number): number {
  return Math.max(1, Math.max(1, Math.floor(columns)) - 2);
}

export type ToastOverlayLayout = {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
  contentWidth: number;
};

export type ToastOverlayLayoutInput = {
  columns: number;
  rows: number;
  promptRows: number;
};

const FOOTER_ROWS = 2;
const VISUAL_GAP_ROWS = 1;
const MINIMUM_TOP_ROW = 3;
const MINIMUM_NOTICE_HEIGHT = 4;

export function toastOverlayLayout(input: ToastOverlayLayoutInput): ToastOverlayLayout | undefined {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const promptRows = Math.max(0, Math.floor(input.promptRows));
  const bottom = FOOTER_ROWS + promptRows + VISUAL_GAP_ROWS;
  const maxHeight = rows - bottom - MINIMUM_TOP_ROW;
  if (maxHeight < MINIMUM_NOTICE_HEIGHT) {
    return undefined;
  }

  const width = Math.max(1, Math.min(72, columns - 4));
  const left = Math.max(0, columns - width - 2);

  return {
    left,
    bottom,
    width,
    maxHeight,
    contentWidth: Math.max(1, width - 2),
  };
}

export type ToastOverlayLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
  contentWidth: number;
};

export type ToastOverlayLayoutInput = {
  columns: number;
  rows: number;
  promptRows: number;
  contentRows: number;
};

const FOOTER_ROWS = 2;
const VISUAL_GAP_ROWS = 1;
const MINIMUM_TOP_ROW = 3;

export function toastOverlayLayout(input: ToastOverlayLayoutInput): ToastOverlayLayout | undefined {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const promptRows = Math.max(0, Math.floor(input.promptRows));
  const contentRows = Math.max(1, Math.floor(input.contentRows));
  const height = contentRows + 2;
  const bottomReservation = FOOTER_ROWS + promptRows + VISUAL_GAP_ROWS;
  const top = rows - bottomReservation - height;
  if (top < MINIMUM_TOP_ROW) {
    return undefined;
  }

  const maxWidth = Math.max(1, Math.min(52, columns - 4));
  const minWidth = Math.max(1, Math.min(columns - 2, 28));
  const width = Math.max(1, maxWidth < minWidth ? maxWidth : Math.max(minWidth, maxWidth));
  const left =
    columns < 56
      ? Math.max(0, Math.floor((columns - width) / 2))
      : Math.max(0, columns - width - 2);

  return {
    left,
    top,
    width,
    height,
    contentWidth: Math.max(1, width - 2),
  };
}

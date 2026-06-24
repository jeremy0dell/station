export type BottomSheetFrameLayout = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function bottomSheetFrameLayout(input: {
  columns: number;
  rows: number;
  contentRows: number;
  minHeight?: number;
}): BottomSheetFrameLayout {
  const width = Math.max(1, input.columns);
  const viewportRows = Math.max(1, input.rows);
  const minHeight = input.minHeight ?? 7;
  const height = Math.min(viewportRows, Math.max(minHeight, input.contentRows + 2));
  return {
    left: 0,
    top: Math.max(0, viewportRows - height),
    width,
    height,
  };
}

export function bottomSheetContentWidth(columns: number): number {
  return Math.max(1, Math.max(1, columns) - 2);
}

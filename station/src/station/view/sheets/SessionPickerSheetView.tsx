import type { ReactElement } from "react";
import { SheetMessageLine } from "../controls/sheetMessages.js";
import { SheetFooter } from "../controls/sheetText.js";
import { bottomSheetContentWidth, compactSheetWidth } from "../layout/bottomSheetFrame.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";

export type SessionPickerSheetViewProps = {
  title: string;
  columns: number;
  rows: number;
  /** The downstream sheet exclusively replaces the chooser after a session is selected. */
  next?: ReactElement;
};

export function SessionPickerSheetView({
  title,
  columns,
  rows,
  next,
}: SessionPickerSheetViewProps) {
  if (next !== undefined) {
    return next;
  }

  const sheetWidth = compactSheetWidth(columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title={title}
      bodyPaddingTop={1}
      footer={<SheetFooter width={contentWidth}>Esc:cancel</SheetFooter>}
    >
      <SheetMessageLine width={contentWidth}>↑↓ move · ↵ choose · slot or click</SheetMessageLine>
    </BottomSheetFrameView>
  );
}

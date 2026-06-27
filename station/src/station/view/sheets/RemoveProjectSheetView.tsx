import { bottomSheetContentWidth, type TuiScreen } from "@station/dashboard-core";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  SheetConfirmButtons,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetMessageLine,
} from "./parts.js";

type RemoveProjectScreen = Extract<TuiScreen, { name: "removeProject" }>;

export type RemoveProjectSheetViewProps = {
  screen: RemoveProjectScreen;
  columns: number;
  rows: number;
};

export function RemoveProjectSheetView({ screen, columns, rows }: RemoveProjectSheetViewProps) {
  const sheetWidth = compactSheetWidth(columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Remove project?"
      contentRows={7}
      minHeight={9}
    >
      <SheetLabelValue width={contentWidth} label="Project" labelWidth={8} value={screen.label} />
      <SheetMessageLine width={contentWidth} tone="danger">
        Removes it from Station. Worktrees and files stay on disk.
      </SheetMessageLine>
      <SheetLine width={contentWidth}> </SheetLine>
      <SheetConfirmButtons width={contentWidth} />
      <SheetFooter width={contentWidth}>Esc/Enter:cancel</SheetFooter>
    </BottomSheetFrameView>
  );
}

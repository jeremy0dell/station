// OpenTUI port of apps/tui's RenameSessionBottomSheet.
import { bottomSheetContentWidth } from "@station/dashboard-core";
import { truncateCells } from "@station/dashboard-core";
import type { TuiScreen } from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { STATION_COLORS } from "../theme.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetFooter, SheetLabelValue, SheetLine } from "./parts.js";

export type RenameSessionSheetViewProps = {
  state: Extract<TuiScreen, { name: "renameSession"; step: "editName" }>;
  columns: number;
  rows: number;
};

export function RenameSessionSheetView({ state, columns, rows }: RenameSessionSheetViewProps) {
  const contentWidth = bottomSheetContentWidth(columns);
  const footer = state.returnTo === "dashboard" ? "Enter:rename   Esc:cancel" : "Enter:rename   Esc:back";
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title="Rename Session"
      contentRows={4}
      minHeight={7}
    >
      {state.validationError === undefined ? <SheetLine width={contentWidth}> </SheetLine> : null}
      <SheetLabelValue
        width={contentWidth}
        label="Name"
        labelWidth={10}
        value={<EditableTextInputView {...state.draftTitle} placeholder={state.currentTitle} />}
      />
      {state.validationError === undefined ? null : (
        <text fg={STATION_COLORS.red}>{truncateCells(` ${state.validationError}`, contentWidth)}</text>
      )}
      <SheetFooter width={contentWidth}>{footer}</SheetFooter>
    </BottomSheetFrameView>
  );
}

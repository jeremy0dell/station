// OpenTUI port of apps/tui's RenameSessionBottomSheet.
import { bottomSheetContentWidth } from "@station/dashboard-core";
import { truncateCells } from "@station/dashboard-core";
import type { TuiScreen } from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { toOpenTuiColor, useStationTheme } from "../../../theme/index.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetButtonRow, SheetFooter, SheetLabelValue, SheetLine, SheetText } from "./parts.js";

export type RenameSessionSheetViewProps = {
  state: Extract<TuiScreen, { name: "renameSession"; step: "editName" }>;
  columns: number;
  rows: number;
};

export function RenameSessionSheetView({ state, columns, rows }: RenameSessionSheetViewProps) {
  const theme = useStationTheme();
  const contentWidth = bottomSheetContentWidth(columns);
  const footer =
    state.returnTo === "dashboard" ? "Enter:rename   Esc:cancel" : "Enter:rename   Esc:back";
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
        <SheetText fg={toOpenTuiColor(theme.status.danger)}>
          {truncateCells(` ${state.validationError}`, contentWidth)}
        </SheetText>
      )}
      <SheetButtonRow
        width={contentWidth}
        buttons={[
          {
            id: "rename.submit",
            label: "Rename",
            shortcut: "enter",
            tone: "primary",
            mouseTarget: { kind: "renameSessionSubmit" },
            focused: false,
            disabled: false,
          },
        ]}
      />
      <SheetFooter width={contentWidth}>{footer}</SheetFooter>
    </BottomSheetFrameView>
  );
}

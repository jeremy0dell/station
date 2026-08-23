// OpenTUI port of apps/tui's RenameSessionBottomSheet.
import { truncateCells } from "@station/dashboard-core/selectors";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { toOpenTuiColor, useStationTheme } from "../../../theme/index.js";
import { bottomSheetContentWidth, BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetButtonRow, SheetFooter, SheetLabelValue, SheetText } from "./parts.js";

export type RenameSessionSheetViewProps = {
  state: Extract<DashboardScreenView, { name: "renameSession"; step: "editName" }>;
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
      bodyPaddingTop={state.validationError === undefined ? 1 : 0}
      actions={
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
      }
      footer={<SheetFooter width={contentWidth}>{footer}</SheetFooter>}
    >
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
    </BottomSheetFrameView>
  );
}

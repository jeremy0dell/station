import { bottomSheetContentWidth, type TuiScreen } from "@station/dashboard-core";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetButton,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetMessageLine,
  spaces,
} from "./parts.js";

type RemoveScreen =
  | Extract<TuiScreen, { name: "removeWorktree" }>
  | Extract<TuiScreen, { name: "removeSession" }>;

export type RemoveSessionSheetViewProps = {
  screen: RemoveScreen;
  columns: number;
  rows: number;
};

export function RemoveSessionSheetView({ screen, columns, rows }: RemoveSessionSheetViewProps) {
  const sheetWidth = compactSheetWidth(columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  if (screen.name === "removeWorktree" && screen.step === "chooseSlot") {
    return (
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        width={sheetWidth}
        title="Select session to remove"
        contentRows={5}
        minHeight={7}
      >
        <SheetLine width={contentWidth}> </SheetLine>
        <SheetMessageLine width={contentWidth}>Click a row or press slot key</SheetMessageLine>
        <SheetFooter width={contentWidth}>Esc:cancel</SheetFooter>
      </BottomSheetFrameView>
    );
  }

  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Remove session?"
      contentRows={7}
      minHeight={9}
    >
      <SheetLabelValue width={contentWidth} label="Session" labelWidth={8} value={screen.label} />
      <SheetMessageLine width={contentWidth} tone="danger">
        {removeHint(screen)}
      </SheetMessageLine>
      <SheetLine width={contentWidth}> </SheetLine>
      <RemoveConfirmButtons width={contentWidth} />
      <SheetFooter width={contentWidth}>Esc/Enter:cancel</SheetFooter>
    </BottomSheetFrameView>
  );
}

function RemoveConfirmButtons({ width }: { width: number }) {
  const gap = width >= 22 ? 2 : 0;
  const buttonWidth = Math.max(1, Math.min(10, Math.floor((width - gap) / 2)));
  return (
    <box flexDirection="row" width={width}>
      <SheetButton
        label="Yes"
        shortcut="y"
        tone="success"
        fixedWidth={buttonWidth}
        mouseTarget={{ kind: "sheetButton", key: "y" }}
      />
      {gap > 0 ? <text>{spaces(gap)}</text> : null}
      <SheetButton
        label="No"
        shortcut="n"
        tone="danger"
        fixedWidth={buttonWidth}
        mouseTarget={{ kind: "sheetButton", key: "n" }}
      />
    </box>
  );
}

function removeHint(screen: RemoveScreen): string {
  if (screen.name === "removeSession") {
    return "Removes the session; checkout stays.";
  }
  return "Removes session, checkout, and panes.";
}

function compactSheetWidth(columns: number): number {
  return Math.min(Math.max(1, Math.floor(columns)), 46);
}

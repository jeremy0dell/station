import { bottomSheetContentWidth, type TuiScreen } from "@station/dashboard-core";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  SheetButtonRow,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetMessageLine,
} from "./parts.js";

type RemoveScreen = Extract<TuiScreen, { name: "removeWorktree" }>;

export type RemoveSessionSheetViewProps = {
  screen: RemoveScreen;
  columns: number;
  rows: number;
};

export function RemoveSessionSheetView({ screen, columns, rows }: RemoveSessionSheetViewProps) {
  const sheetWidth =
    screen.step === "unavailable"
      ? Math.min(Math.max(1, Math.floor(columns)), 68)
      : compactSheetWidth(columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  if (screen.step === "chooseSlot") {
    return (
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        width={sheetWidth}
        title="Select session to delete"
        contentRows={5}
        minHeight={7}
      >
        <SheetLine width={contentWidth}> </SheetLine>
        <SheetMessageLine width={contentWidth}>↑↓ move · ↵ choose · slot or click</SheetMessageLine>
        <SheetFooter width={contentWidth}>Esc:cancel</SheetFooter>
      </BottomSheetFrameView>
    );
  }

  if (screen.step === "unavailable") {
    return (
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        width={sheetWidth}
        title="Cannot delete worktree"
        contentRows={7}
        minHeight={9}
      >
        <SheetMessageLine width={contentWidth}>
          This agent was started outside Station.
        </SheetMessageLine>
        <SheetMessageLine width={contentWidth}>
          Station can see its status, but cannot stop it.
        </SheetMessageLine>
        <SheetLine width={contentWidth}> </SheetLine>
        <SheetMessageLine width={contentWidth}>
          Stop or remove it from its original terminal or external tooling.
        </SheetMessageLine>
        <SheetLine width={contentWidth}> </SheetLine>
        <SheetFooter width={contentWidth}>Esc/Enter:close</SheetFooter>
      </BottomSheetFrameView>
    );
  }

  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Delete session?"
      contentRows={7}
      minHeight={9}
    >
      <SheetLabelValue width={contentWidth} label="Session" labelWidth={8} value={screen.label} />
      <SheetMessageLine width={contentWidth} tone="danger">
        Removes agent, worktree, and panes.
      </SheetMessageLine>
      <SheetLine width={contentWidth}> </SheetLine>
      <SheetButtonRow
        width={contentWidth}
        buttons={[
          {
            id: "confirm.delete",
            label: "Delete",
            shortcut: "Y",
            tone: "danger",
            mouseTarget: {
              kind: "removeWorktreeAction",
              actionId: "confirm.delete",
            },
            focused: screen.actionFocus === "delete",
            disabled: false,
          },
          {
            id: "confirm.keep",
            label: "Keep session",
            compactLabel: "Keep",
            shortcut: "N",
            tone: "neutral",
            mouseTarget: {
              kind: "removeWorktreeAction",
              actionId: "confirm.keep",
            },
            focused: screen.actionFocus === "keep",
            disabled: false,
          },
        ]}
      />
      <SheetFooter width={contentWidth}>
        {contentWidth >= 39
          ? "←→ choose · Enter activate · Esc cancel"
          : "←→ · Enter activate · Esc cancel"}
      </SheetFooter>
    </BottomSheetFrameView>
  );
}

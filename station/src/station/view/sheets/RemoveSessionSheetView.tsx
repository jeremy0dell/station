import { bottomSheetContentWidth, type TuiScreen } from "@station/dashboard-core";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  responsiveSheetFooterText,
  type ResponsiveSheetText,
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

const MIN_SHEET_WIDTH = 1;
const UNAVAILABLE_MAX_SHEET_WIDTH = 68;
const CHOOSE_SLOT_CONTENT_ROWS = 5;
const CHOOSE_SLOT_MIN_HEIGHT = 7;
const DETAIL_CONTENT_ROWS = 7;
const DETAIL_MIN_HEIGHT = 9;
const SESSION_LABEL_WIDTH = 8;

const CONFIRM_HELP = {
  expanded: "←→ choose · Enter activate · Esc cancel",
  compact: "←→ · Enter activate · Esc cancel",
} as const satisfies ResponsiveSheetText;

export function RemoveSessionSheetView({ screen, columns, rows }: RemoveSessionSheetViewProps) {
  const sheetWidth = removeSheetWidth(screen.step, columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  if (screen.step === "chooseSlot") {
    return (
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        width={sheetWidth}
        title="Select session to delete"
        contentRows={CHOOSE_SLOT_CONTENT_ROWS}
        minHeight={CHOOSE_SLOT_MIN_HEIGHT}
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
        contentRows={DETAIL_CONTENT_ROWS}
        minHeight={DETAIL_MIN_HEIGHT}
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
      contentRows={DETAIL_CONTENT_ROWS}
      minHeight={DETAIL_MIN_HEIGHT}
    >
      <SheetLabelValue
        width={contentWidth}
        label="Session"
        labelWidth={SESSION_LABEL_WIDTH}
        value={screen.label}
      />
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
        {responsiveSheetFooterText(contentWidth, CONFIRM_HELP)}
      </SheetFooter>
    </BottomSheetFrameView>
  );
}

function removeSheetWidth(step: RemoveScreen["step"], columns: number): number {
  if (step !== "unavailable") {
    return compactSheetWidth(columns);
  }
  return Math.min(
    Math.max(MIN_SHEET_WIDTH, Math.floor(columns)),
    UNAVAILABLE_MAX_SHEET_WIDTH,
  );
}

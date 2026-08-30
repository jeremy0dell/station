import type { DashboardScreenView } from "@station/dashboard-core/state";
import { SheetButtonRow } from "../controls/sheetButtons.js";
import { SheetMessageLine } from "../controls/sheetMessages.js";
import {
  responsiveSheetFooterText,
  type ResponsiveSheetText,
  SheetFooter,
  SheetLabelValue,
} from "../controls/sheetText.js";
import { bottomSheetContentWidth, compactSheetWidth } from "../layout/bottomSheetFrame.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";

type RemoveScreen = Extract<DashboardScreenView, { name: "removeWorktree" }>;
type RemoveDownstreamScreen = Exclude<RemoveScreen, { step: "chooseSlot" }>;

export type RemoveSessionSheetViewProps = {
  screen: RemoveDownstreamScreen;
  columns: number;
  rows: number;
};

const MIN_SHEET_WIDTH = 1;
const UNAVAILABLE_MAX_SHEET_WIDTH = 68;
const SESSION_LABEL_WIDTH = 8;

const CONFIRM_HELP = {
  expanded: "←→ choose · Enter activate · Esc cancel",
  compact: "←→ · Enter activate · Esc cancel",
} as const satisfies ResponsiveSheetText;

export function RemoveSessionSheetView({ screen, columns, rows }: RemoveSessionSheetViewProps) {
  const sheetWidth = removeSheetWidth(screen.step, columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  if (screen.step === "unavailable") {
    return (
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        width={sheetWidth}
        title="Cannot delete worktree"
        bodyPaddingBottom={1}
        footer={<SheetFooter width={contentWidth}>Esc/Enter:close</SheetFooter>}
      >
        <SheetMessageLine width={contentWidth}>
          Station cannot stop the active agent.
        </SheetMessageLine>
        <SheetMessageLine width={contentWidth}>
          Stop it in its terminal before deleting the worktree.
        </SheetMessageLine>
      </BottomSheetFrameView>
    );
  }

  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Delete session?"
      bodyPaddingBottom={1}
      actions={
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
      }
      footer={
        <SheetFooter width={contentWidth}>
          {responsiveSheetFooterText(contentWidth, CONFIRM_HELP)}
        </SheetFooter>
      }
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
    </BottomSheetFrameView>
  );
}

function removeSheetWidth(step: RemoveDownstreamScreen["step"], columns: number): number {
  if (step !== "unavailable") {
    return compactSheetWidth(columns);
  }
  return Math.min(
    Math.max(MIN_SHEET_WIDTH, Math.floor(columns)),
    UNAVAILABLE_MAX_SHEET_WIDTH,
  );
}

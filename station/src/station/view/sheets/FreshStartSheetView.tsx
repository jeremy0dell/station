import type { DashboardScreenView } from "@station/dashboard-core/state";
import { bottomSheetContentWidth, BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  responsiveSheetFooterText,
  type ResponsiveSheetText,
  SheetButtonRow,
  SheetFooter,
  SheetLabelValue,
  SheetMessageLine,
} from "./parts.js";

type FreshStartScreen = Extract<DashboardScreenView, { name: "freshStart" }>;

const SESSION_LABEL_WIDTH = 8;
const CONFIRM_HELP = {
  expanded: "←→ choose · Enter activate · Esc cancel",
  compact: "←→ · Enter activate · Esc cancel",
} as const satisfies ResponsiveSheetText;

export function FreshStartSheetView({
  screen,
  columns,
  rows,
}: {
  screen: FreshStartScreen;
  columns: number;
  rows: number;
}) {
  const width = compactSheetWidth(columns);
  const contentWidth = bottomSheetContentWidth(width);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={width}
      title="Start fresh?"
      bodyPaddingBottom={1}
      actions={
        <SheetButtonRow
          width={contentWidth}
          buttons={[
            {
              id: "confirm.startFresh",
              label: "Start fresh",
              shortcut: "Y",
              tone: "danger",
              mouseTarget: {
                kind: "freshStartAction",
                actionId: "confirm.startFresh",
              },
              focused: screen.actionFocus === "startFresh",
              disabled: false,
            },
            {
              id: "confirm.cancel",
              label: "Cancel",
              shortcut: "N",
              tone: "neutral",
              mouseTarget: {
                kind: "freshStartAction",
                actionId: "confirm.cancel",
              },
              focused: screen.actionFocus === "cancel",
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
        Resume is unavailable for this agent.
      </SheetMessageLine>
      <SheetMessageLine width={contentWidth}>Starts a new agent conversation.</SheetMessageLine>
      <SheetMessageLine width={contentWidth}>Keeps this worktree and its panes.</SheetMessageLine>
    </BottomSheetFrameView>
  );
}

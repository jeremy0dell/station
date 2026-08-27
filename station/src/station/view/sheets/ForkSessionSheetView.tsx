// Fork details share semantic controls across pointer and keyboard activation;
// only submit invokes the managed-session capability, so Copy-focused Enter remains a core toggle.
import { cellWidth } from "@station/dashboard-core/text";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { bottomSheetContentWidth } from "../layout/bottomSheetFrame.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  responsiveSheetFooterText,
  responsiveSheetText,
  type ResponsiveSheetText,
  SheetButtonRow,
  SheetControlRow,
  SheetFooter,
  SheetLabelValue,
  SheetMessageLine,
} from "./parts.js";

type ForkDetailsScreen = Extract<DashboardScreenView, { name: "fork"; step: "details" }>;

export type ForkSessionSheetViewProps = {
  screen: ForkDetailsScreen;
  columns: number;
  rows: number;
};

const SOURCE_LABEL_WIDTH = 8;
const CONTROL_LABEL_WIDTH = 6;

const FORK_ACTION_HELP = {
  expanded: "↑↓ focus · Enter fork · Esc back",
  compact: "↑↓ · Enter fork · Esc",
} as const satisfies ResponsiveSheetText;

const GROUP_HELP = {
  expanded: "Space/Enter toggle · ↑↓ focus · Esc back",
  compact: "Space/↵ toggle · ↑↓ · Esc back",
} as const satisfies ResponsiveSheetText;

const COPY_DIRTY_HELP = {
  expanded: "Space/Enter toggle · ↑↓ focus · Esc back",
  compact: "Space/↵ toggle · ↑↓ · Esc back",
} as const satisfies ResponsiveSheetText;

const DETAILS_HELP_BY_FOCUS = {
  name: FORK_ACTION_HELP,
  group: GROUP_HELP,
  copyDirty: COPY_DIRTY_HELP,
  submit: FORK_ACTION_HELP,
} as const satisfies Record<ForkDetailsScreen["focus"], ResponsiveSheetText>;

const SOURCE_RUNNING_MESSAGE = {
  expanded: "Source keeps running — copy is read-only.",
  compact: "Source running; copy is read-only.",
} as const satisfies ResponsiveSheetText;

export function ForkSessionSheetView({ screen, columns, rows }: ForkSessionSheetViewProps) {
  const sheetWidth = compactSheetWidth(columns);
  const contentWidth = bottomSheetContentWidth(sheetWidth);
  return (
    <ForkDetails
      screen={screen}
      columns={columns}
      rows={rows}
      contentWidth={contentWidth}
      sheetWidth={sheetWidth}
    />
  );
}

function ForkDetails({
  screen,
  columns,
  rows,
  contentWidth,
  sheetWidth,
}: {
  screen: ForkDetailsScreen;
  columns: number;
  rows: number;
  contentWidth: number;
  sheetWidth: number;
}) {
  const focus = screen.focus;
  const titleValue =
    focus === "name" ? (
      <EditableTextInputView {...screen.draftTitle} active />
    ) : (
      screen.draftTitle.value
    );
  const footerText = responsiveSheetFooterText(contentWidth, DETAILS_HELP_BY_FOCUS[focus]);
  const groupValue =
    screen.sourceGroup === undefined
      ? "(Ungrouped)"
      : screen.inheritSourceGroup
        ? `[x] create in ${screen.sourceGroup.name}`
        : "[ ] (Ungrouped)";
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Fork Session"
      bodyPaddingBottom={1}
      actions={
        <SheetButtonRow
          width={contentWidth}
          buttons={[
            {
              id: "fork.submit",
              label: "Fork",
              shortcut: "enter",
              tone: "success",
              mouseTarget: {
                kind: "forkSessionAction",
                actionId: "details.submit",
              },
              focused: focus === "submit",
              disabled: false,
            },
          ]}
        />
      }
      footer={<SheetFooter width={contentWidth}>{footerText}</SheetFooter>}
    >
      <SheetLabelValue
        width={contentWidth}
        label="Source"
        labelWidth={SOURCE_LABEL_WIDTH}
        value={`${screen.projectLabel} · ${screen.sourceBranch}`}
      />
      <SheetControlRow
        width={contentWidth}
        label="Name"
        labelWidth={CONTROL_LABEL_WIDTH}
        value={titleValue}
        valueCells={cellWidth(screen.draftTitle.value) + Number(focus === "name")}
        focused={focus === "name"}
        mouseTarget={{ kind: "forkSessionAction", actionId: "details.name" }}
      />
      {screen.sourceGroup === undefined ? (
        <SheetLabelValue
          width={contentWidth}
          label="Group"
          labelWidth={CONTROL_LABEL_WIDTH}
          value={groupValue}
        />
      ) : (
        <SheetControlRow
          width={contentWidth}
          label="Group"
          labelWidth={CONTROL_LABEL_WIDTH}
          value={groupValue}
          valueCells={cellWidth(groupValue)}
          focused={focus === "group"}
          mouseTarget={{ kind: "forkSessionAction", actionId: "details.group" }}
        />
      )}
      <SheetControlRow
        width={contentWidth}
        label="Copy"
        labelWidth={CONTROL_LABEL_WIDTH}
        value={`[${screen.copyDirty ? "x" : " "}] uncommitted changes`}
        focused={focus === "copyDirty"}
        mouseTarget={{ kind: "forkSessionAction", actionId: "details.copyDirty" }}
      />
      {screen.sourceAgentRunning ? (
        <SheetMessageLine width={contentWidth} tone="muted">
          {responsiveSheetText(contentWidth, SOURCE_RUNNING_MESSAGE)}
        </SheetMessageLine>
      ) : null}
      {screen.validationError !== undefined ? (
        <SheetMessageLine width={contentWidth} tone="danger">
          {screen.validationError}
        </SheetMessageLine>
      ) : null}
    </BottomSheetFrameView>
  );
}

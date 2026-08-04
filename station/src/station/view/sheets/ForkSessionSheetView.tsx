// Fork details share semantic controls across pointer and keyboard activation;
// native Station intercepts only submit so Copy-focused Enter remains a core toggle.
import {
  bottomSheetContentWidth,
  type DashboardScreenView,
} from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
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
  SheetLine,
  SheetMessageLine,
} from "./parts.js";

type ForkScreen = Extract<DashboardScreenView, { name: "fork" }>;
type ForkDetailsScreen = Extract<ForkScreen, { step: "details" }>;

export type ForkSessionSheetViewProps = {
  screen: ForkScreen;
  columns: number;
  rows: number;
};

const SOURCE_LABEL_WIDTH = 8;
const CONTROL_LABEL_WIDTH = 6;
const CHOOSE_SLOT_CONTENT_ROWS = 5;
const CHOOSE_SLOT_MIN_HEIGHT = 7;
const DETAILS_BASE_CONTENT_ROWS = 7;
const DETAILS_MIN_HEIGHT = 9;

const FORK_ACTION_HELP = {
  expanded: "↑↓ focus · Enter fork · Esc back",
  compact: "↑↓ · Enter fork · Esc",
} as const satisfies ResponsiveSheetText;

const COPY_DIRTY_HELP = {
  expanded: "Space/Enter toggle · ↑↓ focus · Esc back",
  compact: "Space/↵ toggle · ↑↓ · Esc back",
} as const satisfies ResponsiveSheetText;

const DETAILS_HELP_BY_FOCUS = {
  name: FORK_ACTION_HELP,
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
  if (screen.step === "chooseSlot") {
    return (
      <BottomSheetFrameView
        columns={columns}
        rows={rows}
        width={sheetWidth}
        title="Select session to fork"
        contentRows={CHOOSE_SLOT_CONTENT_ROWS}
        minHeight={CHOOSE_SLOT_MIN_HEIGHT}
      >
        <SheetLine width={contentWidth}> </SheetLine>
        <SheetMessageLine width={contentWidth}>↑↓ move · ↵ choose · slot or click</SheetMessageLine>
        <SheetFooter width={contentWidth}>Esc:cancel</SheetFooter>
      </BottomSheetFrameView>
    );
  }
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
  const extraRows = [
    screen.sourceAgentRunning,
    screen.validationError !== undefined,
  ].filter(Boolean).length;
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Fork Session"
      contentRows={DETAILS_BASE_CONTENT_ROWS + extraRows}
      minHeight={DETAILS_MIN_HEIGHT}
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
        valueCells={screen.draftTitle.value.length + Number(focus === "name")}
        focused={focus === "name"}
        mouseTarget={{ kind: "forkSessionAction", actionId: "details.name" }}
      />
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
      <SheetLine width={contentWidth}> </SheetLine>
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
      <SheetFooter width={contentWidth}>{footerText}</SheetFooter>
    </BottomSheetFrameView>
  );
}

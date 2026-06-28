// OpenTUI bottom sheet for Fork Session: chooseSlot (pick a source row, mirrors
// RemoveSessionSheetView) and details (branch field + copy-dirty toggle + submit,
// mirrors NewSessionSheetView's EditName). The submit button is a click target so
// the fork launches in Station (sheetSubmit → launch-fork), never the tmux path.
import { bottomSheetContentWidth, type TuiScreen } from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  SheetButton,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetMessageLine,
} from "./parts.js";

type ForkScreen = Extract<TuiScreen, { name: "fork" }>;
type ForkDetailsScreen = Extract<ForkScreen, { step: "details" }>;

export type ForkSessionSheetViewProps = {
  screen: ForkScreen;
  columns: number;
  rows: number;
};

const LABEL_WIDTH = 8;

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
        contentRows={5}
        minHeight={7}
      >
        <SheetLine width={contentWidth}> </SheetLine>
        <SheetMessageLine width={contentWidth}>Click a row or press slot key</SheetMessageLine>
        <SheetFooter width={contentWidth}>Esc:cancel</SheetFooter>
      </BottomSheetFrameView>
    );
  }
  return <ForkDetails screen={screen} columns={columns} rows={rows} contentWidth={contentWidth} sheetWidth={sheetWidth} />;
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
  const branchValue =
    focus === "branch" ? (
      <EditableTextInputView {...screen.draftBranch} />
    ) : (
      screen.draftBranch.value
    );
  const extraRows = (screen.sourceAgentRunning ? 1 : 0) + (screen.validationError !== undefined ? 1 : 0);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      width={sheetWidth}
      title="Fork Session"
      contentRows={7 + extraRows}
      minHeight={9}
    >
      <SheetLabelValue
        width={contentWidth}
        label="Source"
        labelWidth={LABEL_WIDTH}
        value={`${screen.projectLabel} · ${screen.sourceBranch}`}
      />
      <SheetLabelValue
        width={contentWidth}
        label={focusLabel("Branch", focus === "branch")}
        labelWidth={LABEL_WIDTH}
        value={branchValue}
      />
      <SheetLabelValue
        width={contentWidth}
        label={focusLabel("Copy", focus === "copyDirty")}
        labelWidth={LABEL_WIDTH}
        value={`[${screen.copyDirty ? "x" : " "}] uncommitted changes`}
      />
      {screen.sourceAgentRunning ? (
        <SheetMessageLine width={contentWidth} tone="muted">
          Source keeps running — copy is read-only.
        </SheetMessageLine>
      ) : null}
      {screen.validationError !== undefined ? (
        <SheetMessageLine width={contentWidth} tone="danger">
          {screen.validationError}
        </SheetMessageLine>
      ) : null}
      <SheetLine width={contentWidth}> </SheetLine>
      <SheetButton
        label={focus === "submit" ? "> Fork" : "Fork"}
        shortcut="enter"
        tone="success"
        fixedWidth={Math.min(contentWidth, 18)}
        mouseTarget={{ kind: "sheetSubmit" }}
      />
      <SheetFooter width={contentWidth}>↑↓:field space:toggle enter:fork esc:back</SheetFooter>
    </BottomSheetFrameView>
  );
}

/** Prefix a field label with a focus caret so the active field reads clearly. */
function focusLabel(label: string, focused: boolean): string {
  return `${focused ? ">" : " "} ${label}`;
}

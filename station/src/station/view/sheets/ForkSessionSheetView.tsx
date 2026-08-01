// Fork details share semantic controls across pointer and keyboard activation;
// native Station intercepts only submit so Copy-focused Enter remains a core toggle.
import { bottomSheetContentWidth, type TuiScreen } from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  compactSheetWidth,
  SheetButtonRow,
  SheetControlRow,
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
        <SheetMessageLine width={contentWidth}>↑↓ move · ↵ choose · slot or click</SheetMessageLine>
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
  const titleValue =
    focus === "name" ? (
      <EditableTextInputView {...screen.draftTitle} active />
    ) : (
      screen.draftTitle.value
    );
  const helper =
    focus === "copyDirty"
      ? contentWidth >= 40
        ? "Space/Enter toggle · ↑↓ focus · Esc back"
        : "Space/↵ toggle · ↑↓ · Esc back"
      : contentWidth >= 32
        ? "↑↓ focus · Enter fork · Esc back"
        : "↑↓ · Enter fork · Esc";
  const extraRows =
    (screen.sourceAgentRunning ? 1 : 0) +
    (screen.validationError !== undefined ? 1 : 0);
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
      <SheetControlRow
        width={contentWidth}
        label="Name"
        labelWidth={LABEL_WIDTH - 2}
        value={titleValue}
        valueCells={screen.draftTitle.value.length + Number(focus === "name")}
        focused={focus === "name"}
        mouseTarget={{ kind: "forkSessionAction", actionId: "details.name" }}
      />
      <SheetControlRow
        width={contentWidth}
        label="Copy"
        labelWidth={LABEL_WIDTH - 2}
        value={`[${screen.copyDirty ? "x" : " "}] uncommitted changes`}
        focused={focus === "copyDirty"}
        mouseTarget={{ kind: "forkSessionAction", actionId: "details.copyDirty" }}
      />
      {screen.sourceAgentRunning ? (
        <SheetMessageLine width={contentWidth} tone="muted">
          {contentWidth >= 41
            ? "Source keeps running — copy is read-only."
            : "Source running; copy is read-only."}
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
      <SheetFooter width={contentWidth}>{helper}</SheetFooter>
    </BottomSheetFrameView>
  );
}

import { addProjectActions, addProjectRows, addProjectSelectedIndexForFlow } from "@station/dashboard-core/state";
import type { AddProjectFlowStateView, TuiSelectionState } from "@station/dashboard-core/state";
import { SheetButtonRow, type SheetButtonSpec } from "../controls/sheetButtons.js";
import {
  SheetMessageLine,
  SheetMetaLine,
  SheetProgressFooter,
  SheetSectionLine,
} from "../controls/sheetMessages.js";
import { SheetPickerLine } from "../controls/sheetPicker.js";
import { SheetFooter, SheetLabelValue } from "../controls/sheetText.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { bottomSheetContentWidth } from "../layout/bottomSheetFrame.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";

export type AddProjectSheetViewProps = {
  state: AddProjectFlowStateView;
  selection: TuiSelectionState;
  columns: number;
  rows: number;
};

export function AddProjectSheetView({ state, selection, columns, rows }: AddProjectSheetViewProps) {
  const contentWidth = bottomSheetContentWidth(columns);
  const selectedIndex = addProjectSelectedIndexForFlow(state, selection);
  const bodyItemIds = addProjectBodyItemIds(state);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={titleForState(state)}
      bodyHeader={
        state.mode === "choose" ? <FolderPickerContext state={state} width={contentWidth} /> : undefined
      }
      bodyItemIds={bodyItemIds}
      followedBodyItemId={selectedIndex === undefined ? undefined : bodyItemIds[selectedIndex]}
      bodyPaddingBottom={state.mode === "review" && state.gitRoot !== undefined ? 1 : 0}
      actions={<AddProjectActionBar width={contentWidth} state={state} selectedIndex={selectedIndex} />}
      footer={addProjectFooter(state, contentWidth)}
    >
      {renderState(state, selectedIndex, contentWidth)}
    </BottomSheetFrameView>
  );
}

function renderState(
  state: AddProjectFlowStateView,
  selectedIndex: number | undefined,
  width: number,
) {
  if (state.mode === "start") {
    return (
      <StartChoices
        state={state}
        selectedIndex={selectedIndex}
        width={width}
      />
    );
  }
  if (state.mode === "choose") {
    return (
      <FolderPicker
        state={state}
        selectedIndex={selectedIndex}
        width={width}
      />
    );
  }
  if (state.mode === "review") {
    return <Review state={state} width={width} />;
  }
  if (state.mode === "success") {
    return <Success state={state} width={width} />;
  }
  return <Failure state={state} width={width} />;
}

function StartChoices({
  state,
  selectedIndex,
  width,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "start" }>;
  selectedIndex: number | undefined;
  width: number;
}) {
  return (
    <>
      <SheetSectionLine width={width}>Start location</SheetSectionLine>
      {state.choices.map((choice, index) => (
        <SheetPickerLine
          key={choice.id}
          width={width}
          selected={index === selectedIndex}
          label={choice.label}
          detail={choice.detail}
          mouseTarget={{ kind: "addProjectRow", itemId: choice.id }}
          itemId={choice.id}
        />
      ))}
    </>
  );
}

function FolderPicker({
  state,
  selectedIndex,
  width,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "choose" }>;
  selectedIndex: number | undefined;
  width: number;
}) {
  const rows = addProjectRows(state);
  if (state.filter.length > 0 && rows.length === 0) {
    return (
      <>
        <SheetMessageLine width={width} tone="muted">
          {state.searching ? "Searching likely code folders..." : "0 matches"}
        </SheetMessageLine>
        <SheetMessageLine width={width}>
          {state.searching ? "Looking under common project roots." : "No folders matched."}
        </SheetMessageLine>
        <SheetMessageLine width={width} tone="muted">
          Try another search or paste a full path.
        </SheetMessageLine>
      </>
    );
  }
  return (
    <>
      {state.error === undefined ? null : (
        <SheetMessageLine width={width} tone="danger">
          {state.error.message}
        </SheetMessageLine>
      )}
      {state.searchError === undefined ? null : (
        <SheetMessageLine width={width} tone="danger">
          {`Search failed: ${state.searchError.message}`}
        </SheetMessageLine>
      )}
      {rows.map((row, index) => (
        <SheetPickerLine
          key={`${row.kind}:${row.path}`}
          width={width}
          selected={index === selectedIndex}
          label={rowLabel(row)}
          detail={rowDetail(row.kind)}
          mouseTarget={{ kind: "addProjectRow", itemId: row.path }}
          itemId={folderRowItemId(row)}
        />
      ))}
    </>
  );
}

function FolderPickerContext({
  state,
  width,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "choose" }>;
  width: number;
}) {
  const rows = addProjectRows(state);
  const hasSearchPrompt = state.filterMode || state.filter.length > 0;
  return (
    <box flexDirection="column" marginBottom={hasSearchPrompt ? 0 : 1}>
      <SheetMetaLine width={width} label="Folder" value={state.currentPath} />
      {hasSearchPrompt ? (
        <SheetMetaLine
          width={width}
          label="Search"
          value={
            state.filter.length > 0 ? `${state.filter}   ${matchSummary(state, rows.length)}` : ""
          }
        />
      ) : null}
    </box>
  );
}

function addProjectBodyItemIds(state: AddProjectFlowStateView): string[] {
  if (state.mode === "start") return state.choices.map((choice) => choice.id);
  if (state.mode === "choose") return addProjectRows(state).map(folderRowItemId);
  return [];
}

function folderRowItemId(row: ReturnType<typeof addProjectRows>[number]): string {
  return `${row.kind}:${row.path}`;
}

function rowLabel(row: ReturnType<typeof addProjectRows>[number]): string {
  if (row.kind === "current") return ".";
  if (row.kind === "search") return `${row.displayPath ?? row.path}/`;
  return `${row.name}/`;
}

function rowDetail(rowKind: ReturnType<typeof addProjectRows>[number]["kind"]): string {
  if (rowKind === "current") return "this folder";
  return rowKind === "search" ? "match" : "folder";
}

function matchSummary(state: Extract<AddProjectFlowStateView, { mode: "choose" }>, count: number) {
  const suffix = state.searchTruncated ? "+" : "";
  return state.searching ? `${count}${suffix} matches, searching` : `${count}${suffix} matches`;
}

function Review({
  state,
  width,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "review" }>;
  width: number;
}) {
  return (
    <>
      <SheetLabelValue width={width} label="Selected folder" value={state.selectedPath} />
      <SheetLabelValue width={width} label="Git root" value={state.gitRoot ?? "not detected"} />
      <SheetLabelValue
        width={width}
        label="Project id"
        value={
          state.editingId === undefined ? (
            state.id
          ) : (
            <EditableTextInputView value={state.editingId.value} cursor={state.editingId.cursor} />
          )
        }
      />
      <SheetLabelValue width={width} label="Display name" value={state.label} />
      {state.gitRoot === undefined ? (
        <SheetMessageLine width={width} tone="warning">
          Choose a folder inside an existing Git repository.
        </SheetMessageLine>
      ) : null}
    </>
  );
}

function Success({
  state,
  width,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "success" }>;
  width: number;
}) {
  return (
    <>
      <SheetLabelValue width={width} label="Project" value={state.label} />
      <SheetLabelValue width={width} label="Root" value={state.root} />
      <SheetMessageLine width={width} tone="success">
        Config updated. Reconciled successfully.
      </SheetMessageLine>
    </>
  );
}

function Failure({
  state,
  width,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "failed" }>;
  width: number;
}) {
  const metadataRows = failureMetadataRows(state.error);
  return (
    <>
      <SheetMessageLine width={width} tone="danger">
        Could not add this project.
      </SheetMessageLine>
      <SheetMessageLine width={width}>{state.error.message}</SheetMessageLine>
      {state.error.hint === undefined ? null : (
        <SheetMessageLine width={width} tone="muted">
          {state.error.hint}
        </SheetMessageLine>
      )}
      {metadataRows.map((row) => (
        <SheetMetaLine key={row.label} width={width} label={row.label} value={row.value} />
      ))}
    </>
  );
}

function failureMetadataRows(
  error: Extract<AddProjectFlowStateView, { mode: "failed" }>["error"],
): Array<{ label: string; value: string }> {
  const rows = [{ label: "Code", value: error.code }];
  if (error.traceId !== undefined) rows.push({ label: "Trace", value: error.traceId });
  if (error.commandId !== undefined) rows.push({ label: "Command", value: error.commandId });
  if (error.diagnosticId !== undefined) rows.push({ label: "Diag", value: error.diagnosticId });
  return rows;
}

function reviewHelper(state: Extract<AddProjectFlowStateView, { mode: "review" }>): string {
  if (state.editingId !== undefined) {
    const action =
      state.editIdActionFocus === "back" ? "Enter back without saving" : "Enter save project id";
    return `↑↓ action · ${action}`;
  }
  switch (state.actionFocus) {
    case "submit":
      return `←→ action · ${state.gitRoot === undefined ? "Enter choose Git folder" : "Enter add project"}`;
    case "editId":
      return "←→ action · Enter edit project id";
    case "chooseFolder":
      return "←→ action · Enter choose another folder";
    case "cancel":
      return "←→ action · Enter cancel";
  }
}

function titleForState(state: AddProjectFlowStateView): string {
  if (state.mode === "start") return state.firstProject ? "Add Your First Project" : "Add Project";
  if (state.mode === "choose") return "Choose Project Folder";
  if (state.mode === "review") return "Add Project: Review";
  if (state.mode === "success") return "Project Added";
  return "Add Project Failed";
}

function addProjectFooter(state: AddProjectFlowStateView, width: number) {
  if (state.mode === "start") {
    return (
      <SheetFooter width={width}>Click selects · Open enters · ↑↓ + Enter supported</SheetFooter>
    );
  }
  if (state.mode === "choose") {
    const noMatches = state.filter.length > 0 && addProjectRows(state).length === 0;
    return (
      <SheetFooter width={width}>
        {noMatches
          ? "Backspace edit · Ctrl-U clear · Esc clears search"
          : state.filterMode
            ? "Type search/path · Esc clears"
            : "Single-click selects · actions complete navigation"}
      </SheetFooter>
    );
  }
  if (state.mode === "review") {
    return state.submitting ? (
      <SheetProgressFooter width={width}>Adding project</SheetProgressFooter>
    ) : (
      <SheetFooter width={width}>{reviewHelper(state)}</SheetFooter>
    );
  }
  if (state.mode === "success") {
    return <SheetFooter width={width}>Enter or D returns to dashboard</SheetFooter>;
  }
  return <SheetFooter width={width}>←→ action · Enter activates focused action</SheetFooter>;
}

function AddProjectActionBar({
  width,
  state,
  selectedIndex,
}: {
  width: number;
  state: AddProjectFlowStateView;
  selectedIndex?: number;
}) {
  const actions = addProjectActions(state, selectedIndex);
  const focusedAction =
    state.mode === "review"
      ? state.editingId === undefined
        ? state.actionFocus
        : state.editIdActionFocus
      : state.mode === "success" || state.mode === "failed"
        ? state.actionFocus
        : undefined;
  const buttons = actions.map(
    (action) =>
      ({
        id: action.id,
        label: action.label,
        compactLabel: action.compactLabel,
        shortcut: action.accelerator,
        tone: action.intent === "primary" ? "primary" : "neutral",
        mouseTarget: { kind: "addProjectAction", actionId: action.id },
        focused: action.focus !== undefined && action.focus === focusedAction,
        disabled: !action.enabled,
      }) satisfies SheetButtonSpec,
  );
  if (state.mode === "review" && state.editingId !== undefined) {
    return (
      <>
        {buttons.map((button) => (
          <SheetButtonRow key={button.id} width={width} buttons={[button]} />
        ))}
      </>
    );
  }
  return <SheetButtonRow width={width} buttons={buttons} />;
}

import {
  addProjectActions,
  addProjectRows,
  addProjectSelectedIndexForFlow,
  bottomSheetContentWidth,
  type AddProjectFlowStateView,
  type TuiSelectionState,
} from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetButtonRow,
  type SheetButtonSpec,
  SheetFill,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetMessageLine,
  SheetMetaLine,
  SheetPickerLine,
  SheetProgressFooter,
  SheetSectionLine,
} from "./parts.js";

export type AddProjectSheetViewProps = {
  state: AddProjectFlowStateView;
  selection: TuiSelectionState;
  columns: number;
  rows: number;
};

export function AddProjectSheetView({ state, selection, columns, rows }: AddProjectSheetViewProps) {
  const targetHeight = fixedSheetHeight(rows);
  const contentWidth = bottomSheetContentWidth(columns);
  const selectedIndex = addProjectSelectedIndexForFlow(state, selection);
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={titleForState(state)}
      contentRows={Math.max(1, targetHeight - 2)}
      minHeight={targetHeight}
    >
      {renderState(state, selectedIndex, contentWidth, Math.max(1, targetHeight - 3))}
    </BottomSheetFrameView>
  );
}

function renderState(
  state: AddProjectFlowStateView,
  selectedIndex: number | undefined,
  width: number,
  contentRows: number,
) {
  if (state.mode === "start") {
    return (
      <StartChoices
        state={state}
        selectedIndex={selectedIndex}
        width={width}
        contentRows={contentRows}
      />
    );
  }
  if (state.mode === "choose") {
    return (
      <FolderPicker
        state={state}
        selectedIndex={selectedIndex}
        width={width}
        contentRows={contentRows}
      />
    );
  }
  if (state.mode === "review") {
    return <Review state={state} width={width} />;
  }
  if (state.mode === "success") {
    return <Success state={state} width={width} />;
  }
  return <Failure state={state} width={width} contentRows={contentRows} />;
}

function StartChoices({
  state,
  selectedIndex,
  width,
  contentRows,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "start" }>;
  selectedIndex: number | undefined;
  width: number;
  contentRows: number;
}) {
  const visible = state.choices.slice(0, Math.max(0, contentRows - 4));
  return (
    <>
      <SheetSectionLine width={width}>Start location</SheetSectionLine>
      <SheetLine width={width}> </SheetLine>
      {visible.map((choice, index) => (
        <SheetPickerLine
          key={choice.path}
          width={width}
          selected={index === selectedIndex}
          label={choice.label}
          detail={choice.detail}
          mouseTarget={{ kind: "addProjectRow", index }}
        />
      ))}
      <SheetFill count={Math.max(0, contentRows - visible.length - 4)} width={width} />
      <AddProjectActionBar width={width} state={state} selectedIndex={selectedIndex} />
      <SheetFooter width={width}>Click selects · Open enters · ↑↓ + Enter supported</SheetFooter>
    </>
  );
}

function FolderPicker({
  state,
  selectedIndex,
  width,
  contentRows,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "choose" }>;
  selectedIndex: number | undefined;
  width: number;
  contentRows: number;
}) {
  const rows = addProjectRows(state);
  const hasSearchPrompt = state.filterMode || state.filter.length > 0;
  const errorRows = Number(state.error !== undefined) + Number(state.searchError !== undefined);
  const listHeight = Math.max(1, contentRows - (hasSearchPrompt ? 6 : 5) - errorRows);
  const start = Math.max(0, Math.min(selectedIndex ?? 0, rows.length - listHeight));
  const visible = rows.slice(start, start + listHeight);
  if (state.filter.length > 0 && rows.length === 0) {
    return (
      <>
        <SheetMetaLine width={width} label="Folder" value={state.currentPath} />
        <SheetMetaLine width={width} label="Search" value={state.filter} />
        <SheetMessageLine width={width} tone="muted">
          {state.searching ? "Searching likely code folders..." : "0 matches"}
        </SheetMessageLine>
        <SheetMessageLine width={width}>
          {state.searching ? "Looking under common project roots." : "No folders matched."}
        </SheetMessageLine>
        <SheetMessageLine width={width} tone="muted">
          Try another search or paste a full path.
        </SheetMessageLine>
        <SheetFill count={Math.max(0, contentRows - 7)} width={width} />
        <AddProjectActionBar width={width} state={state} selectedIndex={selectedIndex} />
        <SheetFooter width={width}>Backspace edit · Ctrl-U clear · Esc clears search</SheetFooter>
      </>
    );
  }
  return (
    <>
      <SheetMetaLine width={width} label="Folder" value={state.currentPath} />
      {hasSearchPrompt ? (
        <SheetMetaLine
          width={width}
          label="Search"
          value={
            state.filter.length > 0
              ? `${state.filter}   ${matchSummary(state, rows.length)}   ${start + 1}-${start + visible.length} of ${rows.length}`
              : ""
          }
        />
      ) : (
        <SheetLine width={width}> </SheetLine>
      )}
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
      {visible.map((row, index) => (
        <SheetPickerLine
          key={`${row.kind}:${row.path}`}
          width={width}
          selected={start + index === selectedIndex}
          label={rowLabel(row)}
          detail={rowDetail(row.kind)}
          mouseTarget={{ kind: "addProjectRow", index: start + index }}
        />
      ))}
      <SheetFill
        count={Math.max(0, contentRows - visible.length - 5 - errorRows)}
        width={width}
      />
      <AddProjectActionBar width={width} state={state} selectedIndex={selectedIndex} />
      <SheetFooter width={width}>
        {state.filterMode ? "Type search/path · Esc clears" : "Single-click selects · actions complete navigation"}
      </SheetFooter>
    </>
  );
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
      ) : (
        <SheetLine width={width}> </SheetLine>
      )}
      <AddProjectActionBar width={width} state={state} />
      {state.submitting ? (
        <SheetProgressFooter width={width}>Adding project</SheetProgressFooter>
      ) : (
        <SheetFooter width={width}>{reviewHelper(state)}</SheetFooter>
      )}
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
      <AddProjectActionBar width={width} state={state} />
      <SheetFooter width={width}>Enter or D returns to dashboard</SheetFooter>
    </>
  );
}

function Failure({
  state,
  width,
  contentRows,
}: {
  state: Extract<AddProjectFlowStateView, { mode: "failed" }>;
  width: number;
  contentRows: number;
}) {
  const staticRows = state.error.hint === undefined ? 7 : 8;
  const metadataRows = failureMetadataRows(state.error).slice(
    0,
    Math.max(0, contentRows - staticRows),
  );
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
      <AddProjectActionBar width={width} state={state} />
      <SheetFooter width={width}>←→ action · Enter activates focused action</SheetFooter>
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

function fixedSheetHeight(rows: number): number {
  return Math.min(Math.max(1, rows - 2), 18);
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

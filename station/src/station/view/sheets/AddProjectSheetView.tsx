import {
  addProjectRows,
  addProjectSelectedIndexForFlow,
  bottomSheetContentWidth,
  type AddProjectActionId,
  type AddProjectFlowState,
  type TuiSelectionState,
} from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetActionRow,
  SheetButton,
  SheetFill,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetMessageLine,
  SheetMetaLine,
  SheetPickerLine,
  SheetProgressFooter,
  SheetSectionLine,
  spaces,
  type SheetButtonTone,
} from "./parts.js";

export type AddProjectSheetViewProps = {
  state: AddProjectFlowState;
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
  state: AddProjectFlowState,
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
  state: Extract<AddProjectFlowState, { mode: "start" }>;
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
      <AddProjectActionBar
        width={width}
        actions={[
          { id: "start.open", label: "Open", compactLabel: "Open", shortcut: "→/↵", tone: "primary" },
          { id: "start.cancel", label: "Cancel", compactLabel: "Back", shortcut: "Esc", tone: "neutral" },
        ]}
      />
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
  state: Extract<AddProjectFlowState, { mode: "choose" }>;
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
  const actions: InlineAddProjectAction[] = [
    { id: "choose.choose", label: "Choose", compactLabel: "Use", shortcut: "↵", tone: "primary" },
    { id: "choose.open", label: "Open", compactLabel: "Open", shortcut: "→", tone: "neutral" },
    { id: "choose.parent", label: "Parent", compactLabel: "Up", shortcut: "←", tone: "neutral" },
    {
      id: "choose.search",
      label: "Search",
      compactLabel: "Find",
      shortcut: "/",
      tone: "neutral",
      disabled: state.filterMode,
    },
    { id: "choose.cancel", label: "Cancel", compactLabel: "Exit", shortcut: "Esc", tone: "neutral" },
  ];
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
        <AddProjectActionBar width={width} actions={actions} />
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
      <AddProjectActionBar width={width} actions={actions} />
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

function matchSummary(state: Extract<AddProjectFlowState, { mode: "choose" }>, count: number) {
  const suffix = state.searchTruncated ? "+" : "";
  return state.searching ? `${count}${suffix} matches, searching` : `${count}${suffix} matches`;
}

function Review({
  state,
  width,
}: {
  state: Extract<AddProjectFlowState, { mode: "review" }>;
  width: number;
}) {
  const editing = state.editingId !== undefined;
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
      {editing ? (
        <>
          <SheetActionRow
            width={width}
            label="Save id"
            shortcut="Ctrl-S"
            tone="primary"
            focused={state.editIdActionFocus === "save"}
            mouseTarget={{ kind: "addProjectAction", actionId: "editId.save" }}
          />
          <SheetActionRow
            width={width}
            label="Back"
            shortcut="Esc"
            focused={state.editIdActionFocus === "back"}
            mouseTarget={{ kind: "addProjectAction", actionId: "editId.back" }}
          />
        </>
      ) : (
        <>
          <SheetActionRow
            width={width}
            label="Add project"
            shortcut="A"
            tone="primary"
            focused={state.actionFocus === "submit"}
            disabled={state.gitRoot === undefined || state.submitting}
            mouseTarget={{ kind: "addProjectAction", actionId: "review.submit" }}
          />
          <SheetActionRow
            width={width}
            label="Edit id"
            shortcut="N"
            focused={state.actionFocus === "editId"}
            disabled={state.submitting}
            mouseTarget={{ kind: "addProjectAction", actionId: "review.editId" }}
          />
          <SheetActionRow
            width={width}
            label="Choose folder"
            shortcut="B"
            focused={state.actionFocus === "chooseFolder"}
            disabled={state.submitting}
            mouseTarget={{ kind: "addProjectAction", actionId: "review.chooseFolder" }}
          />
          <SheetActionRow
            width={width}
            label="Cancel"
            shortcut="Esc"
            focused={state.actionFocus === "cancel"}
            disabled={state.submitting}
            mouseTarget={{ kind: "addProjectAction", actionId: "review.cancel" }}
          />
        </>
      )}
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
  state: Extract<AddProjectFlowState, { mode: "success" }>;
  width: number;
}) {
  return (
    <>
      <SheetLabelValue width={width} label="Project" value={state.label} />
      <SheetLabelValue width={width} label="Root" value={state.root} />
      <SheetMessageLine width={width} tone="success">
        Config updated. Reconciled successfully.
      </SheetMessageLine>
      <SheetActionRow
        width={width}
        label="Dashboard"
        shortcut="D"
        tone="primary"
        focused={state.actionFocus === "dashboard"}
        mouseTarget={{ kind: "addProjectAction", actionId: "success.dashboard" }}
      />
      <SheetFooter width={width}>Enter or D returns to dashboard</SheetFooter>
    </>
  );
}

function Failure({
  state,
  width,
  contentRows,
}: {
  state: Extract<AddProjectFlowState, { mode: "failed" }>;
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
      <SheetActionRow
        width={width}
        label="Retry"
        shortcut="R"
        tone="primary"
        focused={state.actionFocus === "retry"}
        mouseTarget={{ kind: "addProjectAction", actionId: "failed.retry" }}
      />
      <SheetActionRow
        width={width}
        label="Choose folder"
        shortcut="B"
        focused={state.actionFocus === "chooseFolder"}
        mouseTarget={{ kind: "addProjectAction", actionId: "failed.chooseFolder" }}
      />
      <SheetActionRow
        width={width}
        label="Cancel"
        shortcut="Esc"
        focused={state.actionFocus === "cancel"}
        mouseTarget={{ kind: "addProjectAction", actionId: "failed.cancel" }}
      />
      <SheetFooter width={width}>↑↓ action · Enter activates focused action</SheetFooter>
    </>
  );
}

function failureMetadataRows(
  error: Extract<AddProjectFlowState, { mode: "failed" }>["error"],
): Array<{ label: string; value: string }> {
  const rows = [{ label: "Code", value: error.code }];
  if (error.traceId !== undefined) rows.push({ label: "Trace", value: error.traceId });
  if (error.commandId !== undefined) rows.push({ label: "Command", value: error.commandId });
  if (error.diagnosticId !== undefined) rows.push({ label: "Diag", value: error.diagnosticId });
  return rows;
}

function reviewHelper(state: Extract<AddProjectFlowState, { mode: "review" }>): string {
  if (state.editingId !== undefined) {
    return state.editIdActionFocus === "back" ? "Enter back without saving" : "Enter save project id";
  }
  switch (state.actionFocus) {
    case "submit":
      return state.gitRoot === undefined ? "Enter choose Git folder" : "Enter add project";
    case "editId":
      return "Enter edit project id";
    case "chooseFolder":
      return "Enter choose another folder";
    case "cancel":
      return "Enter cancel";
  }
}

function titleForState(state: AddProjectFlowState): string {
  if (state.mode === "start") return state.firstProject ? "Add Your First Project" : "Add Project";
  if (state.mode === "choose") return "Choose Project Folder";
  if (state.mode === "review") return "Add Project: Review";
  if (state.mode === "success") return "Project Added";
  return "Add Project Failed";
}

function fixedSheetHeight(rows: number): number {
  return Math.min(Math.max(1, rows - 2), 18);
}

type InlineAddProjectAction = {
  id: AddProjectActionId;
  label: string;
  compactLabel: string;
  shortcut: string;
  tone: SheetButtonTone;
  disabled?: boolean;
};

function AddProjectActionBar({
  width,
  actions,
}: {
  width: number;
  actions: readonly InlineAddProjectAction[];
}) {
  const gap = width >= actions.length * 10 ? 1 : 0;
  const buttonWidth = Math.max(1, Math.floor((width - gap * (actions.length - 1)) / actions.length));
  const compact = buttonWidth < 11;
  return (
    <box flexDirection="row" width={width} height={1}>
      {actions.map((action, index) => (
        <box key={action.id} flexDirection="row" height={1}>
          {index === 0 || gap === 0 ? null : <text>{spaces(gap)}</text>}
          <SheetButton
            label={compact ? action.compactLabel : action.label}
            shortcut={action.shortcut}
            tone={action.tone}
            fixedWidth={buttonWidth}
            disabled={action.disabled === true}
            mouseTarget={{ kind: "addProjectAction", actionId: action.id }}
          />
        </box>
      ))}
    </box>
  );
}

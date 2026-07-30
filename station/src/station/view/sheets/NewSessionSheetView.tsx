import type { ProjectView, ProviderId, StationSnapshot } from "@station/contracts";
import {
  bottomSheetContentWidth,
  newSessionContentRowCount,
  newSessionReviewContent,
  selectedProject,
  selectNewSessionHarnessChoices,
  selectNewSessionProjectChoices,
  type NewSessionActionId,
  type NewSessionFlowState,
  type NewSessionReviewFieldId,
  type TuiSelectionState,
} from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { providerHealthStatusColor } from "../theme.js";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetActionRow,
  SheetChoiceLine,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
} from "./parts.js";

export type NewSessionSheetViewProps = {
  snapshot: StationSnapshot;
  state: NewSessionFlowState;
  selection: TuiSelectionState;
  columns: number;
  rows: number;
};

export function NewSessionSheetView({
  snapshot,
  state,
  selection,
  columns,
  rows,
}: NewSessionSheetViewProps) {
  const project = selectedProject(snapshot, state);
  const optionCount = optionCountForState(snapshot, state, project);
  const contentWidth = bottomSheetContentWidth(columns);

  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={titleForState(state)}
      contentRows={newSessionContentRowCount(state, optionCount)}
    >
      {renderMode(snapshot, state, project, selection, contentWidth)}
    </BottomSheetFrameView>
  );
}

function renderMode(
  snapshot: StationSnapshot,
  state: NewSessionFlowState,
  project: ProjectView | undefined,
  selection: TuiSelectionState,
  contentWidth: number,
) {
  if (state.mode === "pickProject") {
    return (
      <ProjectPicker
        snapshot={snapshot}
        width={contentWidth}
        selectedId={selection.get("newSessionPickProject") as ProjectView["id"] | undefined}
      />
    );
  }
  if (state.mode === "pickAgent") {
    if (project === undefined) {
      return <SheetFooter width={contentWidth}>No project is available · Esc back</SheetFooter>;
    }
    return (
      <AgentPicker
        snapshot={snapshot}
        project={project}
        width={contentWidth}
        selectedId={selection.get("newSessionPickAgent") as ProviderId | undefined}
      />
    );
  }
  if (state.mode === "editName") {
    return <EditName state={state} project={project} width={contentWidth} />;
  }
  return <Review snapshot={snapshot} state={state} width={contentWidth} />;
}

function titleForState(state: NewSessionFlowState): string {
  switch (state.mode) {
    case "review":
      return "Create Session";
    case "editName":
      return "Set Session Name";
    case "pickProject":
      return "Choose Project";
    case "pickAgent":
      return "Choose Agent";
  }
}

const REVIEW_ACTION_IDS: Readonly<Record<NewSessionReviewFieldId, NewSessionActionId>> = {
  project: "review.project",
  name: "review.name",
  agent: "review.agent",
};

function Review({
  snapshot,
  state,
  width,
}: {
  snapshot: StationSnapshot;
  state: Extract<NewSessionFlowState, { mode: "review" }>;
  width: number;
}) {
  const content = newSessionReviewContent(snapshot, state);
  return (
    <>
      {content.fields.map((field) => {
        const status = field.status;
        return (
          <SheetActionRow
            key={field.id}
            width={width}
            label={field.label}
            detail={field.value}
            focused={state.reviewFocus === field.id}
            mouseTarget={{ kind: "newSessionAction", actionId: REVIEW_ACTION_IDS[field.id] }}
            {...(status === undefined
              ? {}
              : {
                  status: {
                    glyph: status.glyph,
                    text: status.text,
                    color: providerHealthStatusColor(status.tone),
                  },
                })}
          />
        );
      })}
      <SheetActionRow
        width={width}
        label={content.create.label}
        shortcut={content.create.shortcut}
        tone="primary"
        focused={state.reviewFocus === "create"}
        disabled={content.create.disabled}
        mouseTarget={{ kind: "newSessionAction", actionId: "review.create" }}
      />
      <SheetFooter width={width}>{`↑↓ focus · ${content.helper} · Esc cancel`}</SheetFooter>
    </>
  );
}

function EditName({
  state,
  project,
  width,
}: {
  state: Extract<NewSessionFlowState, { mode: "editName" }>;
  project: ProjectView | undefined;
  width: number;
}) {
  const nameValue = state.draftName.value.length === 0 ? state.title : state.draftName.value;
  return (
    <>
      <SheetLabelValue width={width} label="Project" labelWidth={12} value={project?.label ?? "-"} />
      <SheetActionRow
        width={width}
        label="Name"
        detail={
          <EditableTextInputView
            value={state.draftName.value}
            cursor={state.draftName.cursor}
            placeholder={state.title}
            active={state.editNameFocus === "name"}
          />
        }
        detailCells={nameValue.length + Number(state.editNameFocus === "name")}
        focused={state.editNameFocus === "name"}
        mouseTarget={{ kind: "newSessionAction", actionId: "editName.name" }}
      />
      <SheetActionRow
        width={width}
        label="Save"
        shortcut="Ctrl-S"
        tone="primary"
        focused={state.editNameFocus === "save"}
        mouseTarget={{ kind: "newSessionAction", actionId: "editName.save" }}
      />
      <SheetActionRow
        width={width}
        label="Back"
        shortcut="Esc"
        focused={state.editNameFocus === "back"}
        mouseTarget={{ kind: "newSessionAction", actionId: "editName.back" }}
      />
      <SheetFooter width={width}>{editNameHelper(state.editNameFocus)}</SheetFooter>
    </>
  );
}

function editNameHelper(focus: Extract<NewSessionFlowState, { mode: "editName" }>["editNameFocus"]): string {
  if (focus === "name") return "Type name · Left/Right cursor · Enter save · ↑↓ focus";
  if (focus === "save") return "Enter save name · ↑↓ focus · Esc back";
  return "Enter back without saving · ↑↓ focus";
}

function ProjectPicker({
  snapshot,
  width,
  selectedId,
}: {
  snapshot: StationSnapshot;
  width: number;
  selectedId?: ProjectView["id"];
}) {
  const projects = selectNewSessionProjectChoices(snapshot);
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      {projects.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.label}
          detail={choice.value.health.status}
          color={providerHealthStatusColor(choice.value.health.status)}
          width={width}
          selected={choice.value.id === selectedId}
        />
      ))}
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"↑↓ move   ↵ select   1-9/a-z jump   Esc back"}</SheetFooter>
    </>
  );
}

function AgentPicker({
  snapshot,
  project,
  width,
  selectedId,
}: {
  snapshot: StationSnapshot;
  project: ProjectView;
  width: number;
  selectedId?: ProviderId;
}) {
  const options = selectNewSessionHarnessChoices(snapshot, project);
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      <AgentChoiceListView choices={options} width={width} selectedId={selectedId} />
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"↑↓ move   ↵ select   1-9/a-z jump   Esc back"}</SheetFooter>
    </>
  );
}

function optionCountForState(
  snapshot: StationSnapshot,
  state: NewSessionFlowState,
  project: ProjectView | undefined,
): number {
  if (state.mode === "pickProject") {
    return selectNewSessionProjectChoices(snapshot).length;
  }
  if (state.mode === "pickAgent" && project !== undefined) {
    return selectNewSessionHarnessChoices(snapshot, project).length;
  }
  return 0;
}

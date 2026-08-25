import type { ProviderId } from "@station/contracts";
import {
  newSessionEditGroupDraftContent,
  newSessionEditNameContent,
  newSessionReviewContent,
  selectNewSessionGroupChoices,
  selectNewSessionHarnessChoices,
  selectNewSessionProjectChoices,
} from "@station/dashboard-core/selectors";
import { cellWidth } from "@station/dashboard-core/text";
import {
  NEW_SESSION_CREATE_GROUP_CHOICE_ID,
  NEW_SESSION_GROUP_LIST_ID,
  NEW_SESSION_UNGROUPED_CHOICE_ID,
  newSessionExistingGroupChoiceId,
  selectedProject,
} from "@station/dashboard-core/state";
import type {
  DashboardSnapshotView,
  DashboardStateView,
  NewSessionFlowStateView,
} from "@station/dashboard-core/state";
import { providerHealthColor, useStationTheme } from "../../../theme/index.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { bottomSheetContentWidth } from "../layout/bottomSheetFrame.js";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetButtonRow,
  SheetChoiceLine,
  SheetControlRow,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  SheetProgressFooter,
} from "./parts.js";

type NewSessionProjectView = DashboardSnapshotView["projects"][number];

export type NewSessionSheetViewProps = {
  snapshot: DashboardSnapshotView;
  state: NewSessionFlowStateView;
  selection: DashboardStateView["selection"];
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
  const contentWidth = bottomSheetContentWidth(columns);
  const selectedBodyItemId = selectedBodyItem(state, selection);

  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={titleForState(state)}
      bodyItemIds={bodyItems(snapshot, state, project)}
      followedBodyItemId={selectedBodyItemId}
      bodyPaddingTop={isPicker(state) ? 1 : 0}
      bodyPaddingBottom={isPicker(state) ? 1 : 0}
      actions={actionsForState(snapshot, state, contentWidth)}
      footer={footerForState(snapshot, state, project, contentWidth)}
    >
      {renderMode(snapshot, state, project, selection, contentWidth)}
    </BottomSheetFrameView>
  );
}

function renderMode(
  snapshot: DashboardSnapshotView,
  state: NewSessionFlowStateView,
  project: NewSessionProjectView | undefined,
  selection: DashboardStateView["selection"],
  contentWidth: number,
) {
  if (state.mode === "pickProject") {
    return (
      <ProjectPicker
        snapshot={snapshot}
        width={contentWidth}
        selectedId={selection.get("newSessionPickProject") as NewSessionProjectView["id"] | undefined}
      />
    );
  }
  if (state.mode === "pickAgent") {
    if (project === undefined) {
      return <SheetLine width={contentWidth}>No project is available</SheetLine>;
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
  if (state.mode === "pickGroup") {
    return (
      <GroupPicker
        snapshot={snapshot}
        state={state}
        width={contentWidth}
        selectedId={selection.get(NEW_SESSION_GROUP_LIST_ID)}
      />
    );
  }
  if (state.mode === "editGroupDraft") {
    return <EditGroupDraft state={state} project={project} width={contentWidth} />;
  }
  if (state.mode === "editName") {
    return <EditName state={state} project={project} width={contentWidth} />;
  }
  return <Review snapshot={snapshot} state={state} width={contentWidth} />;
}

function isPicker(state: NewSessionFlowStateView): boolean {
  return state.mode === "pickProject" || state.mode === "pickAgent" || state.mode === "pickGroup";
}

function selectedBodyItem(
  state: NewSessionFlowStateView,
  selection: DashboardStateView["selection"],
): string | undefined {
  switch (state.mode) {
    case "pickProject":
      return selection.get("newSessionPickProject");
    case "pickAgent":
      return selection.get("newSessionPickAgent");
    case "pickGroup":
      return selection.get(NEW_SESSION_GROUP_LIST_ID);
    default:
      return undefined;
  }
}

function bodyItems(
  snapshot: DashboardSnapshotView,
  state: NewSessionFlowStateView,
  project: NewSessionProjectView | undefined,
): string[] {
  switch (state.mode) {
    case "pickProject":
      return selectNewSessionProjectChoices(snapshot).map((choice) => choice.value.id);
    case "pickAgent":
      return project === undefined
        ? []
        : selectNewSessionHarnessChoices(snapshot, project).map((choice) => choice.value.id);
    case "pickGroup":
      return [
        NEW_SESSION_UNGROUPED_CHOICE_ID,
        ...selectNewSessionGroupChoices(snapshot, state.selectedProjectId).map((choice) =>
          newSessionExistingGroupChoiceId(choice.value.id),
        ),
        NEW_SESSION_CREATE_GROUP_CHOICE_ID,
      ];
    default:
      return [];
  }
}

function titleForState(state: NewSessionFlowStateView): string {
  switch (state.mode) {
    case "review":
      return "Create Session";
    case "editName":
      return "Set Session Name";
    case "pickProject":
      return "Choose Project";
    case "pickAgent":
      return "Choose Agent";
    case "pickGroup":
      return "Choose Group";
    case "editGroupDraft":
      return "Create Group";
  }
}

function Review({
  snapshot,
  state,
  width,
}: {
  snapshot: DashboardSnapshotView;
  state: Extract<NewSessionFlowStateView, { mode: "review" }>;
  width: number;
}) {
  const theme = useStationTheme();
  const content = newSessionReviewContent(snapshot, state);
  return (
    <>
      {content.fields.map((field) => {
        const status = field.status;
        return (
          <SheetControlRow
            key={field.id}
            width={width}
            label={field.label}
            shortcut={field.accelerator}
            value={field.value}
            focused={state.reviewFocus === field.focusId}
            disabled={!field.enabled}
            mouseTarget={{ kind: "newSessionAction", actionId: field.actionId }}
            {...(status === undefined
              ? {}
              : {
                  status: {
                    glyph: status.glyph,
                    text: status.text,
                    color: providerHealthColor(theme, status.tone),
                  },
                })}
          />
        );
      })}
    </>
  );
}

function GroupPicker({
  snapshot,
  state,
  width,
  selectedId,
}: {
  snapshot: DashboardSnapshotView;
  state: Extract<NewSessionFlowStateView, { mode: "pickGroup" }>;
  width: number;
  selectedId?: string;
}) {
  const choices = selectNewSessionGroupChoices(snapshot, state.selectedProjectId);
  return (
    <>
      <SheetChoiceLine
        choiceKey="U"
        label="Ungrouped"
        detail=""
        width={width}
        current={state.groupSelection.kind === "ungrouped"}
        selected={selectedId === NEW_SESSION_UNGROUPED_CHOICE_ID}
        itemId={NEW_SESSION_UNGROUPED_CHOICE_ID}
      />
      {choices.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.name}
          detail=""
          width={width}
          current={
            state.groupSelection.kind === "existing" &&
            state.groupSelection.groupId === choice.value.id
          }
          selected={selectedId === newSessionExistingGroupChoiceId(choice.value.id)}
          itemId={newSessionExistingGroupChoiceId(choice.value.id)}
        />
      ))}
      <SheetChoiceLine
        choiceKey="N"
        label={
          state.groupSelection.kind === "create"
            ? `Create “${state.groupSelection.name}”`
            : "Create new Group"
        }
        detail=""
        width={width}
        current={state.groupSelection.kind === "create"}
        selected={selectedId === NEW_SESSION_CREATE_GROUP_CHOICE_ID}
        itemId={NEW_SESSION_CREATE_GROUP_CHOICE_ID}
      />
    </>
  );
}

function EditGroupDraft({
  state,
  project,
  width,
}: {
  state: Extract<NewSessionFlowStateView, { mode: "editGroupDraft" }>;
  project: NewSessionProjectView | undefined;
  width: number;
}) {
  return (
    <>
      <SheetLabelValue
        width={width}
        label="Project"
        labelWidth={12}
        value={project?.label ?? "-"}
      />
      <SheetControlRow
        width={width}
        label="Group"
        value={
          <EditableTextInputView
            value={state.draftGroupName.value}
            cursor={state.draftGroupName.cursor}
            placeholder="Group name"
            active
          />
        }
        valueCells={cellWidth(state.draftGroupName.value) + 1}
        focused
        mouseTarget={{ kind: "sheetBackdrop" }}
      />
    </>
  );
}

function EditName({
  state,
  project,
  width,
}: {
  state: Extract<NewSessionFlowStateView, { mode: "editName" }>;
  project: NewSessionProjectView | undefined;
  width: number;
}) {
  const nameValue = state.draftName.value.length === 0 ? state.title : state.draftName.value;
  const content = newSessionEditNameContent(state);
  return (
    <>
      <SheetLabelValue
        width={width}
        label="Project"
        labelWidth={12}
        value={project?.label ?? "-"}
      />
      <SheetControlRow
        width={width}
        label={content.controls.name.label}
        value={
          <EditableTextInputView
            value={state.draftName.value}
            cursor={state.draftName.cursor}
            placeholder={state.title}
            active={state.editNameFocus === "name"}
          />
        }
        valueCells={cellWidth(nameValue) + Number(state.editNameFocus === "name")}
        focused={state.editNameFocus === content.controls.name.focusId}
        disabled={!content.controls.name.enabled}
        mouseTarget={{ kind: "newSessionAction", actionId: content.controls.name.actionId }}
      />
    </>
  );
}

function ProjectPicker({
  snapshot,
  width,
  selectedId,
}: {
  snapshot: DashboardSnapshotView;
  width: number;
  selectedId?: NewSessionProjectView["id"];
}) {
  const theme = useStationTheme();
  const projects = selectNewSessionProjectChoices(snapshot);
  return (
    <>
      {projects.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.label}
          detail={choice.value.health.status}
          color={providerHealthColor(theme, choice.value.health.status)}
          width={width}
          selected={choice.value.id === selectedId}
          itemId={choice.value.id}
        />
      ))}
    </>
  );
}

function AgentPicker({
  snapshot,
  project,
  width,
  selectedId,
}: {
  snapshot: DashboardSnapshotView;
  project: NewSessionProjectView;
  width: number;
  selectedId?: ProviderId;
}) {
  const options = selectNewSessionHarnessChoices(snapshot, project);
  return <AgentChoiceListView choices={options} width={width} selectedId={selectedId} />;
}

function actionsForState(
  snapshot: DashboardSnapshotView,
  state: NewSessionFlowStateView,
  width: number,
) {
  if (state.mode === "review") {
    const content = newSessionReviewContent(snapshot, state);
    return (
      <SheetButtonRow
        width={width}
        buttons={[
          {
            id: content.create.actionId,
            label: content.create.label,
            compactLabel: "Create",
            shortcut: content.create.accelerator ?? "Enter",
            tone: "primary",
            focused: state.reviewFocus === content.create.focusId,
            disabled: !content.create.enabled,
            mouseTarget: { kind: "newSessionAction", actionId: content.create.actionId },
          },
        ]}
      />
    );
  }
  if (state.mode === "editGroupDraft") {
    const content = newSessionEditGroupDraftContent(state);
    return (
      <SheetButtonRow
        width={width}
        buttons={[
          {
            id: content.controls.save.actionId,
            label: content.controls.save.label,
            shortcut: content.controls.save.accelerator ?? "Enter",
            tone: "primary",
            focused: false,
            disabled: !content.controls.save.enabled,
            mouseTarget: { kind: "newSessionAction", actionId: content.controls.save.actionId },
          },
          {
            id: content.controls.back.actionId,
            label: content.controls.back.label,
            shortcut: content.controls.back.accelerator ?? "Esc",
            tone: "neutral",
            focused: false,
            disabled: !content.controls.back.enabled,
            mouseTarget: { kind: "newSessionAction", actionId: content.controls.back.actionId },
          },
        ]}
      />
    );
  }
  if (state.mode === "editName") {
    const content = newSessionEditNameContent(state);
    return (
      <SheetButtonRow
        width={width}
        buttons={[
          {
            id: content.controls.save.actionId,
            label: content.controls.save.label,
            shortcut: content.controls.save.accelerator ?? "Enter",
            tone: "primary",
            focused: state.editNameFocus === content.controls.save.focusId,
            disabled: !content.controls.save.enabled,
            mouseTarget: { kind: "newSessionAction", actionId: content.controls.save.actionId },
          },
          {
            id: content.controls.back.actionId,
            label: content.controls.back.label,
            shortcut: content.controls.back.accelerator ?? "Esc",
            tone: "neutral",
            focused: state.editNameFocus === content.controls.back.focusId,
            disabled: !content.controls.back.enabled,
            mouseTarget: { kind: "newSessionAction", actionId: content.controls.back.actionId },
          },
        ]}
      />
    );
  }
  return undefined;
}

function footerForState(
  snapshot: DashboardSnapshotView,
  state: NewSessionFlowStateView,
  project: NewSessionProjectView | undefined,
  width: number,
) {
  switch (state.mode) {
    case "review": {
      const helper = newSessionReviewContent(snapshot, state).helper;
      return state.submissionLocalId === undefined ? (
        <SheetFooter width={width}>{`↑↓ focus · ${helper} · Esc cancel`}</SheetFooter>
      ) : (
        <SheetProgressFooter width={width}>{helper}</SheetProgressFooter>
      );
    }
    case "editGroupDraft":
      return (
        <SheetFooter width={width}>{newSessionEditGroupDraftContent(state).helper}</SheetFooter>
      );
    case "editName":
      return <SheetFooter width={width}>{newSessionEditNameContent(state).helper}</SheetFooter>;
    case "pickGroup":
      return (
        <SheetFooter width={width}>
          ↑↓ move   ↵ select   U ungrouped   N create   Esc back
        </SheetFooter>
      );
    case "pickProject":
      return (
        <SheetFooter width={width}>↑↓ move   ↵ select   1-9/a-z jump   Esc back</SheetFooter>
      );
    case "pickAgent":
      return project === undefined ? (
        <SheetFooter width={width}>No project is available · Esc back</SheetFooter>
      ) : (
        <SheetFooter width={width}>↑↓ move   ↵ select   1-9/a-z jump   Esc back</SheetFooter>
      );
  }
}

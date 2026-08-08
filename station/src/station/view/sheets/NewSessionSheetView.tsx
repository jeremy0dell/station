import type { ProviderId } from "@station/contracts";
import {
  bottomSheetContentWidth,
  newSessionContentRowCount,
  newSessionEditNameContent,
  newSessionReviewContent,
  selectNewSessionHarnessChoices,
  selectNewSessionProjectChoices,
 } from "@station/dashboard-core/selectors";
import { selectedProject } from "@station/dashboard-core/state";
import type { DashboardSnapshotView, DashboardStateView, NewSessionFlowStateView } from "@station/dashboard-core/state";
import { providerHealthColor, useStationTheme } from "../../../theme/index.js";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import {
  SheetButtonRow,
  SheetChoiceLine,
  SheetControlRow,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
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
      <SheetFooter width={width}>{`↑↓ focus · ${content.helper} · Esc cancel`}</SheetFooter>
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
        valueCells={nameValue.length + Number(state.editNameFocus === "name")}
        focused={state.editNameFocus === content.controls.name.focusId}
        disabled={!content.controls.name.enabled}
        mouseTarget={{ kind: "newSessionAction", actionId: content.controls.name.actionId }}
      />
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
            mouseTarget: {
              kind: "newSessionAction",
              actionId: content.controls.save.actionId,
            },
          },
          {
            id: content.controls.back.actionId,
            label: content.controls.back.label,
            shortcut: content.controls.back.accelerator ?? "Esc",
            tone: "neutral",
            focused: state.editNameFocus === content.controls.back.focusId,
            disabled: !content.controls.back.enabled,
            mouseTarget: {
              kind: "newSessionAction",
              actionId: content.controls.back.actionId,
            },
          },
        ]}
      />
      <SheetFooter width={width}>{content.helper}</SheetFooter>
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
      <SheetLine width={width}> </SheetLine>
      {projects.map((choice) => (
        <SheetChoiceLine
          key={choice.value.id}
          choiceKey={choice.key}
          label={choice.value.label}
          detail={choice.value.health.status}
          color={providerHealthColor(theme, choice.value.health.status)}
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
  snapshot: DashboardSnapshotView;
  project: NewSessionProjectView;
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
  snapshot: DashboardSnapshotView,
  state: NewSessionFlowStateView,
  project: NewSessionProjectView | undefined,
): number {
  if (state.mode === "pickProject") {
    return selectNewSessionProjectChoices(snapshot).length;
  }
  if (state.mode === "pickAgent" && project !== undefined) {
    return selectNewSessionHarnessChoices(snapshot, project).length;
  }
  return 0;
}

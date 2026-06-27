// OpenTUI port of apps/tui's NewSessionBottomSheet (review / editName /
// pickProject / pickAgent). Picker lines are click targets dispatching their
// slot key through the station mouse router.
import type { ProjectView, StationSnapshot } from "@station/contracts";
import { type NewSessionFlowState, selectedProject } from "@station/dashboard-core";
import {
  bottomSheetContentWidth,
  newSessionContentRowCount,
} from "@station/dashboard-core";
import {
  selectNewSessionHarnessChoices,
  selectNewSessionHarnessOptions,
  selectNewSessionProjectChoices,
} from "@station/dashboard-core";
import { EditableTextInputView } from "../EditableTextInputView.js";
import { providerHealthStatusColor, STATION_COLORS } from "../theme.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import {
  SheetChoiceLine,
  SheetFooter,
  SheetLabelValue,
  SheetLine,
  spaces,
} from "./parts.js";

export type NewSessionSheetViewProps = {
  snapshot: StationSnapshot;
  state: NewSessionFlowState;
  columns: number;
  rows: number;
};

export function NewSessionSheetView({ snapshot, state, columns, rows }: NewSessionSheetViewProps) {
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
      {renderMode(snapshot, state, project, contentWidth)}
    </BottomSheetFrameView>
  );
}

function renderMode(
  snapshot: StationSnapshot,
  state: NewSessionFlowState,
  project: ProjectView | undefined,
  contentWidth: number,
) {
  if (state.mode === "pickProject") {
    return <ProjectPicker snapshot={snapshot} width={contentWidth} />;
  }
  if (state.mode === "pickAgent" && project !== undefined) {
    return <AgentPicker snapshot={snapshot} project={project} width={contentWidth} />;
  }
  if (state.mode === "editName") {
    return <EditName state={state} project={project} width={contentWidth} />;
  }
  return <Review snapshot={snapshot} state={state} project={project} width={contentWidth} />;
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

function Review({
  snapshot,
  state,
  project,
  width,
}: {
  snapshot: StationSnapshot;
  state: NewSessionFlowState;
  project: ProjectView | undefined;
  width: number;
}) {
  const harness =
    project === undefined ? undefined : selectedHarnessOption(snapshot, project, state);
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      <SheetLabelValue width={width} label="Project" labelWidth={10} value={project?.label ?? "-"} />
      <SheetLabelValue
        width={width}
        label="Name"
        labelWidth={10}
        value={state.branch}
        {...(state.nameSource === "generated" ? { valueColor: STATION_COLORS.gray } : {})}
      />
      <SheetLabelValue
        width={width}
        label="Agent"
        labelWidth={10}
        value={harness === undefined ? state.selectedHarness : `${harness.label} ${harness.status}`}
        {...colorProp(providerHealthStatusColor(harness?.status))}
      />
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"Enter:create N:name P:project A:agent Esc:cancel"}</SheetFooter>
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
  const labelText = ` ${"Name".padEnd(10)} `;
  const inputLength =
    (state.draftName.value.length === 0 ? state.branch.length : state.draftName.value.length) + 1;
  const padding = spaces(Math.max(0, width - labelText.length - inputLength));
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      <SheetLabelValue width={width} label="Project" labelWidth={10} value={project?.label ?? "-"} />
      <SheetLabelValue
        width={width}
        label="Name"
        labelWidth={10}
        value={
          <span>
            <EditableTextInputView {...state.draftName} placeholder={state.branch} />
            {padding}
          </span>
        }
      />
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"Enter:save   Esc:back"}</SheetFooter>
    </>
  );
}

function ProjectPicker({ snapshot, width }: { snapshot: StationSnapshot; width: number }) {
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
        />
      ))}
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"1-9/a-z:select   Esc:back"}</SheetFooter>
    </>
  );
}

function AgentPicker({
  snapshot,
  project,
  width,
}: {
  snapshot: StationSnapshot;
  project: ProjectView;
  width: number;
}) {
  const options = selectNewSessionHarnessChoices(snapshot, project);
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      <AgentChoiceListView choices={options} width={width} />
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"1-9/a-z:select   Esc:back"}</SheetFooter>
    </>
  );
}

function selectedHarnessOption(
  snapshot: StationSnapshot,
  project: ProjectView,
  state: NewSessionFlowState,
) {
  return selectNewSessionHarnessOptions(snapshot, project).find(
    (option) => option.id === state.selectedHarness,
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

function colorProp(color: string | undefined): { valueColor?: string } {
  return color === undefined ? {} : { valueColor: color };
}

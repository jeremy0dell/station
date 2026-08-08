import type { ProviderId } from "@station/contracts";
import { bottomSheetContentWidth, selectNewSessionHarnessChoices } from "@station/dashboard-core/selectors";
import type { KeyedChoice, NewSessionHarnessOption } from "@station/dashboard-core/selectors";
import type { DashboardScreenView, DashboardSnapshotView, DashboardStateView } from "@station/dashboard-core/state";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetFooter, SheetLine } from "./parts.js";

export type ProjectDefaultAgentSheetViewProps = {
  snapshot: DashboardSnapshotView;
  screen: Extract<DashboardScreenView, { name: "projectDefaultAgent" }>;
  selection: DashboardStateView["selection"];
  columns: number;
  rows: number;
};

export function ProjectDefaultAgentSheetView({
  snapshot,
  screen,
  selection,
  columns,
  rows,
}: ProjectDefaultAgentSheetViewProps) {
  const project = snapshot.projects.find((candidate) => candidate.id === screen.projectId);
  const choices = project === undefined ? [] : selectNewSessionHarnessChoices(snapshot, project);
  const contentWidth = bottomSheetContentWidth(columns);
  const title =
    project === undefined ? "Select Project Default Agent" : `Select default agent for ${project.label}`;
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={title}
      contentRows={choices.length + 4}
    >
      <ProjectDefaultAgentPicker
        choices={choices}
        width={contentWidth}
        currentId={project?.defaults.harness}
        selectedId={selection.get("projectDefaultAgent") as ProviderId | undefined}
      />
    </BottomSheetFrameView>
  );
}

function ProjectDefaultAgentPicker({
  choices,
  width,
  currentId,
  selectedId,
}: {
  choices: readonly KeyedChoice<NewSessionHarnessOption>[];
  width: number;
  currentId?: NewSessionHarnessOption["id"];
  selectedId?: NewSessionHarnessOption["id"];
}) {
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      <AgentChoiceListView
        choices={choices}
        width={width}
        currentId={currentId}
        selectedId={selectedId}
      />
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"✓ current   ↑↓ move   ↵ select   1-9/a-z jump   Esc cancel"}</SheetFooter>
    </>
  );
}

import type { ProviderId } from "@station/contracts";
import { selectNewSessionHarnessChoices } from "@station/dashboard-core/selectors";
import type {
  NewSessionHarnessOption,
  SelectionChoice,
} from "@station/dashboard-core/selectors";
import type { DashboardScreenView, DashboardSnapshotView, DashboardStateView } from "@station/dashboard-core/state";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import { bottomSheetContentWidth } from "../layout/bottomSheetFrame.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetFooter } from "./parts.js";

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
  const selectedId = selection.get("projectDefaultAgent") as ProviderId | undefined;
  const title =
    project === undefined ? "Select Project Default Agent" : `Select default agent for ${project.label}`;
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={title}
      bodyItemIds={choices.map((choice) => choice.value.id)}
      followedBodyItemId={selectedId}
      bodyPaddingTop={1}
      bodyPaddingBottom={1}
      footer={
        <SheetFooter width={contentWidth}>
          {"✓ current   ↑↓ move   ↵ select   1-9/a-z jump   Esc cancel"}
        </SheetFooter>
      }
    >
      <ProjectDefaultAgentPicker
        choices={choices}
        width={contentWidth}
        currentId={project?.defaults.harness}
        selectedId={selectedId}
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
  choices: readonly SelectionChoice<NewSessionHarnessOption>[];
  width: number;
  currentId?: NewSessionHarnessOption["id"];
  selectedId?: NewSessionHarnessOption["id"];
}) {
  return (
    <>
      <AgentChoiceListView
        choices={choices}
        width={width}
        currentId={currentId}
        selectedId={selectedId}
      />
    </>
  );
}

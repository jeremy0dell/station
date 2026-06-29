import type { StationSnapshot } from "@station/contracts";
import {
  bottomSheetContentWidth,
  selectNewSessionHarnessChoices,
  type KeyedChoice,
  type NewSessionHarnessOption,
  type TuiScreen,
} from "@station/dashboard-core";
import { AgentChoiceListView } from "./AgentChoiceListView.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetFooter, SheetLine } from "./parts.js";

export type ProjectDefaultAgentSheetViewProps = {
  snapshot: StationSnapshot;
  screen: Extract<TuiScreen, { name: "projectDefaultAgent" }>;
  columns: number;
  rows: number;
};

export function ProjectDefaultAgentSheetView({
  snapshot,
  screen,
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
      />
    </BottomSheetFrameView>
  );
}

function ProjectDefaultAgentPicker({
  choices,
  width,
  currentId,
}: {
  choices: readonly KeyedChoice<NewSessionHarnessOption>[];
  width: number;
  currentId?: NewSessionHarnessOption["id"];
}) {
  return (
    <>
      <SheetLine width={width}> </SheetLine>
      <AgentChoiceListView choices={choices} width={width} currentId={currentId} />
      <SheetLine width={width}> </SheetLine>
      <SheetFooter width={width}>{"✓ current   1-9/a-z:select   Esc:cancel"}</SheetFooter>
    </>
  );
}

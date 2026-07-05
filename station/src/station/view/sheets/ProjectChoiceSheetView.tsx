import type { ProjectId, StationSnapshot } from "@station/contracts";
import {
  bottomSheetContentWidth,
  selectProjectChooserChoices,
  type TuiSelectionState,
} from "@station/dashboard-core";
import { providerHealthStatusColor } from "../theme.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";
import { SheetChoiceLine, SheetFooter, SheetLine } from "./parts.js";

export type ProjectChooserMode = "projectCollapse" | "projectSettingsPicker";

const TITLE: Record<ProjectChooserMode, string> = {
  projectCollapse: "Collapse Project",
  projectSettingsPicker: "Project Settings",
};

export type ProjectChoiceSheetViewProps = {
  snapshot: StationSnapshot;
  mode: ProjectChooserMode;
  selection: TuiSelectionState;
  columns: number;
  rows: number;
};

export function ProjectChoiceSheetView({
  snapshot,
  mode,
  selection,
  columns,
  rows,
}: ProjectChoiceSheetViewProps) {
  const choices = selectProjectChooserChoices(snapshot);
  const width = bottomSheetContentWidth(columns);
  const selectedId = selection.get(mode) as ProjectId | undefined;
  return (
    <BottomSheetFrameView columns={columns} rows={rows} title={TITLE[mode]} contentRows={choices.length + 4}>
      <SheetLine width={width}> </SheetLine>
      {choices.map((choice) => (
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
      <SheetFooter width={width}>{"↑↓ move   ↵ select   1-9/a-z jump   Esc cancel"}</SheetFooter>
    </BottomSheetFrameView>
  );
}

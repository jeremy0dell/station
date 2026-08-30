import type { ProjectId } from "@station/contracts";
import { selectProjectChooserChoices } from "@station/dashboard-core/selectors";
import type { DashboardSnapshotView, DashboardStateView } from "@station/dashboard-core/state";
import { providerHealthColor, useStationTheme } from "../../../theme/index.js";
import { SheetChoiceLine } from "../controls/sheetPicker.js";
import { SheetFooter } from "../controls/sheetText.js";
import { bottomSheetContentWidth } from "../layout/bottomSheetFrame.js";
import { BottomSheetFrameView } from "./BottomSheetFrameView.js";

export type ProjectChooserMode = "projectCollapse" | "projectSettingsPicker";

const TITLE: Record<ProjectChooserMode, string> = {
  projectCollapse: "Collapse Project",
  projectSettingsPicker: "Project Settings",
};

export type ProjectChoiceSheetViewProps = {
  snapshot: DashboardSnapshotView;
  mode: ProjectChooserMode;
  selection: DashboardStateView["selection"];
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
  const theme = useStationTheme();
  const choices = selectProjectChooserChoices(snapshot);
  const width = bottomSheetContentWidth(columns);
  const selectedId = selection.get(mode) as ProjectId | undefined;
  return (
    <BottomSheetFrameView
      columns={columns}
      rows={rows}
      title={TITLE[mode]}
      bodyItemIds={choices.map((choice) => choice.value.id)}
      followedBodyItemId={selectedId}
      bodyPaddingTop={1}
      bodyPaddingBottom={1}
      footer={
        <SheetFooter width={width}>↑↓ move   ↵ select   1-9/a-z jump   Esc cancel</SheetFooter>
      }
    >
      {choices.map((choice) => (
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
    </BottomSheetFrameView>
  );
}

// Maps the active screen to an absolute OpenTUI layer above the dashboard.
// The dashboard never reflows for overlays.
import type { StationSnapshot } from "@station/contracts";
import {
  tuiScreenBehavior,
  type TuiLocalRows,
  type TuiScreen,
  type TuiSelectionState,
} from "@station/dashboard-core";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets/types";
import type { ReactNode } from "react";
import { AddProjectSheetView } from "./sheets/AddProjectSheetView.js";
import { HelpOverlayView } from "./HelpOverlayView.js";
import { NewSessionSheetView } from "./sheets/NewSessionSheetView.js";
import { ProjectChoiceSheetView } from "./sheets/ProjectChoiceSheetView.js";
import { ProjectDefaultAgentSheetView } from "./sheets/ProjectDefaultAgentSheetView.js";
import { ProjectSettingsPanelView } from "./settings/ProjectSettingsPanelView.js";
import { WidgetSettingsPanelView } from "./settings/WidgetSettingsPanelView.js";
import { RenameSessionSheetView } from "./sheets/RenameSessionSheetView.js";
import { RemoveSessionSheetView } from "./sheets/RemoveSessionSheetView.js";
import { ForkSessionSheetView } from "./sheets/ForkSessionSheetView.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";

export type ActiveScreenOverlayViewProps = {
  snapshot: StationSnapshot;
  screen: TuiScreen;
  selection: TuiSelectionState;
  columns: number;
  rows: number;
  localRows: TuiLocalRows;
  /** Live session widget set for the widget-settings panel. */
  widgets?: readonly TuiWidgetConfig[];
  /** False when widget edits cannot be written back to config.toml. */
  widgetsPersisted?: boolean;
};

export function ActiveScreenOverlayView(props: ActiveScreenOverlayViewProps) {
  const { screen, columns, rows } = props;
  const dispatch = useStationMouse();
  const behavior = tuiScreenBehavior(screen);
  const overlay = renderActiveScreenOverlay(props);

  return (
    <>
      {behavior.clickAway !== undefined ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width={columns}
          height={rows}
          zIndex={9}
          {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
        />
      ) : null}
      {overlay}
    </>
  );
}

function renderActiveScreenOverlay({
  snapshot,
  screen,
  selection,
  columns,
  rows,
  localRows,
  widgets = [],
  widgetsPersisted = true,
}: ActiveScreenOverlayViewProps): ReactNode {
  switch (screen.name) {
    case "dashboard":
    case "search":
      return null;
    case "help":
      return <HelpOverlayView columns={columns} rows={rows} />;
    case "widgetSettings":
      return (
        <WidgetSettingsPanelView
          screen={screen}
          widgets={widgets}
          widgetsPersisted={widgetsPersisted}
          columns={columns}
          rows={rows}
        />
      );
    case "addProject":
      return (
        <AddProjectSheetView
          columns={columns}
          rows={rows}
          state={screen.flow}
          selection={selection}
        />
      );
    case "newSession":
      return (
        <NewSessionSheetView
          columns={columns}
          rows={rows}
          snapshot={snapshot}
          state={screen.flow}
          selection={selection}
        />
      );
    case "projectDefaultAgent":
      return (
        <ProjectDefaultAgentSheetView
          columns={columns}
          rows={rows}
          snapshot={snapshot}
          screen={screen}
          selection={selection}
        />
      );
    case "projectCollapse":
    case "projectSettingsPicker":
      return (
        <ProjectChoiceSheetView
          columns={columns}
          rows={rows}
          snapshot={snapshot}
          mode={screen.name}
          selection={selection}
        />
      );
    case "renameSession":
      switch (screen.step) {
        case "chooseSlot":
          return null;
        case "editName":
          return <RenameSessionSheetView columns={columns} rows={rows} state={screen} />;
      }
      return assertNever(screen);
    case "removeWorktree":
      return <RemoveSessionSheetView columns={columns} rows={rows} screen={screen} />;
    case "projectSettings":
      return (
        <ProjectSettingsPanelView
          columns={columns}
          rows={rows}
          snapshot={snapshot}
          screen={screen}
          selection={selection}
          localRows={localRows}
        />
      );
    case "fork":
      return <ForkSessionSheetView columns={columns} rows={rows} screen={screen} />;
  }
  return assertNever(screen);
}

function assertNever(_value: never): never {
  throw new Error("Unhandled active TUI screen overlay.");
}

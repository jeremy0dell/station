// Maps the active screen to an absolute OpenTUI layer above the dashboard.
// The dashboard never reflows for overlays.
import { tuiScreenBehavior } from "@station/dashboard-core/state";
import type { DashboardScreenView, DashboardSnapshotView, DashboardStateView } from "@station/dashboard-core/state";
import { createElement, type ReactNode } from "react";
import { AddProjectSheetView } from "./sheets/AddProjectSheetView.js";
import { HelpOverlayView } from "./HelpOverlayView.js";
import { NewSessionSheetView } from "./sheets/NewSessionSheetView.js";
import { ProjectChoiceSheetView } from "./sheets/ProjectChoiceSheetView.js";
import { ProjectDefaultAgentSheetView } from "./sheets/ProjectDefaultAgentSheetView.js";
import { GroupSettingsPanelView } from "./settings/GroupSettingsPanelView.js";
import { ProjectSettingsPanelView } from "./settings/ProjectSettingsPanelView.js";
import { WidgetSettingsPanelView } from "./settings/WidgetSettingsPanelView.js";
import { RenameSessionSheetView } from "./sheets/RenameSessionSheetView.js";
import { RemoveSessionSheetView } from "./sheets/RemoveSessionSheetView.js";
import { ForkSessionSheetView } from "./sheets/ForkSessionSheetView.js";
import { FreshStartSheetView } from "./sheets/FreshStartSheetView.js";
import { CreateGroupSheetView } from "./sheets/CreateGroupSheetView.js";
import { MoveToGroupSheetView } from "./sheets/MoveToGroupSheetView.js";
import { SessionPickerSheetView } from "./sheets/SessionPickerSheetView.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";

export type ActiveScreenOverlayViewProps = {
  snapshot: DashboardSnapshotView;
  screen: DashboardScreenView;
  selection: DashboardStateView["selection"];
  columns: number;
  rows: number;
  localRows: DashboardStateView["localRows"];
  /** Live session widget set for the widget-settings panel. */
  widgets?: DashboardStateView["widgets"];
  /** False when widget edits cannot be written back to config.toml. */
  widgetsPersisted?: boolean;
};

export function ActiveScreenOverlayView(props: ActiveScreenOverlayViewProps) {
  const { screen, columns, rows } = props;
  const dispatch = useStationMouse();
  const behavior = tuiScreenBehavior(screen);
  const conditionPanelActive =
    screen.name === "persistentFilter" && screen.conditionEditor !== undefined;
  const dashboardMenuActive = screen.name === "projectMenu" || screen.name === "groupMenu";
  const dashboardOwnedOverlay = conditionPanelActive || dashboardMenuActive;
  const overlay = renderActiveScreenOverlay(props);

  return (
    <>
      {behavior.clickAway !== undefined && !dashboardOwnedOverlay ? (
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
      return null;
    case "persistentFilter": {
      return null;
    }
    case "help":
      return (
        <HelpOverlayView
          columns={columns}
          rows={rows}
          focusedEntryId={screen.focusedEntryId}
        />
      );
    case "projectMenu":
    case "groupMenu":
      return null;
    case "createGroup":
      return <CreateGroupSheetView screen={screen} columns={columns} rows={rows} />;
    case "moveToGroup":
      if (screen.step === "chooseSlot") {
        return (
          <SessionPickerSheetView
            title="Select session to move to a Group"
            columns={columns}
            rows={rows}
          />
        );
      }
      return (
        <SessionPickerSheetView
          title="Select session to move to a Group"
          columns={columns}
          rows={rows}
          next={createElement(MoveToGroupSheetView, {
            screen,
            snapshot,
            selection,
            columns,
            rows,
          })}
        />
      );
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
      if (screen.step === "chooseSlot") {
        return (
          <SessionPickerSheetView
            title="Select session to rename"
            columns={columns}
            rows={rows}
          />
        );
      }
      return (
        <SessionPickerSheetView
          title="Select session to rename"
          columns={columns}
          rows={rows}
          next={createElement(RenameSessionSheetView, { columns, rows, state: screen })}
        />
      );
    case "removeWorktree":
      if (screen.step === "chooseSlot") {
        return (
          <SessionPickerSheetView
            title="Select session to delete"
            columns={columns}
            rows={rows}
          />
        );
      }
      return (
        <SessionPickerSheetView
          title="Select session to delete"
          columns={columns}
          rows={rows}
          next={createElement(RemoveSessionSheetView, { columns, rows, screen })}
        />
      );
    case "freshStart":
      return <FreshStartSheetView columns={columns} rows={rows} screen={screen} />;
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
    case "groupSettings":
      return (
        <GroupSettingsPanelView
          columns={columns}
          rows={rows}
          snapshot={snapshot}
          screen={screen}
        />
      );
    case "fork":
      if (screen.step === "chooseSlot") {
        return (
          <SessionPickerSheetView
            title="Select session to fork"
            columns={columns}
            rows={rows}
          />
        );
      }
      return (
        <SessionPickerSheetView
          title="Select session to fork"
          columns={columns}
          rows={rows}
          next={createElement(ForkSessionSheetView, { columns, rows, screen })}
        />
      );
  }
  return assertNever(screen);
}

function assertNever(_value: never): never {
  throw new Error("Unhandled active TUI screen overlay.");
}

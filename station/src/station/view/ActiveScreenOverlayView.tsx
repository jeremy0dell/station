// Maps the active screen to an absolute OpenTUI layer above the dashboard.
// The dashboard never reflows for overlays.
import { tuiScreenBehavior } from "@station/dashboard-core/state";
import type { DashboardScreenView, DashboardSnapshotView, DashboardStateView } from "@station/dashboard-core/state";
import type { ReactNode } from "react";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import { AddProjectSheetView } from "./sheets/AddProjectSheetView.js";
import { DashboardFilterConditionView } from "./DashboardFilterConditionView.js";
import { HelpOverlayView } from "./HelpOverlayView.js";
import { NewSessionSheetView } from "./sheets/NewSessionSheetView.js";
import { ProjectChoiceSheetView } from "./sheets/ProjectChoiceSheetView.js";
import { ProjectDefaultAgentSheetView } from "./sheets/ProjectDefaultAgentSheetView.js";
import { ProjectSettingsPanelView } from "./settings/ProjectSettingsPanelView.js";
import { ProjectMenuView } from "./ProjectMenuView.js";
import { WidgetSettingsPanelView } from "./settings/WidgetSettingsPanelView.js";
import { RenameSessionSheetView } from "./sheets/RenameSessionSheetView.js";
import { RemoveSessionSheetView } from "./sheets/RemoveSessionSheetView.js";
import { ForkSessionSheetView } from "./sheets/ForkSessionSheetView.js";
import { CreateGroupSheetView } from "./sheets/CreateGroupSheetView.js";
import { MoveToGroupSheetView } from "./sheets/MoveToGroupSheetView.js";
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
  /** Absolute row containing the visible Project header that owns an open menu. */
  projectMenuAnchorTop?: number;
};

export function ActiveScreenOverlayView(props: ActiveScreenOverlayViewProps) {
  const { screen, columns, rows } = props;
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const behavior = tuiScreenBehavior(screen);
  const conditionPanelActive =
    screen.name === "persistentFilter" && screen.conditionEditor !== undefined;
  const overlay = renderActiveScreenOverlay(props);

  return (
    <>
      {behavior.clickAway !== undefined ? (
        <>
          <box
            position="absolute"
            left={0}
            top={0}
            width={columns}
            height={rows}
            zIndex={9}
            {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
          />
          {/* Keep the modal help visible while the transparent full-screen layer still blocks it. */}
          {conditionPanelActive && rows > 1 ? (
            <box
              position="absolute"
              left={0}
              top={0}
              width={columns}
              height={rows - 1}
              zIndex={9}
              backgroundColor={toOpenTuiColor(theme.filter.conditionBackdrop)}
              {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
            />
          ) : null}
        </>
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
  projectMenuAnchorTop = 0,
}: ActiveScreenOverlayViewProps): ReactNode {
  switch (screen.name) {
    case "dashboard":
      return null;
    case "persistentFilter": {
      if (screen.conditionEditor === undefined) return null;
      const top = snapshot.projects.length === 0 ? 3 : 4;
      return (
        <DashboardFilterConditionView
          screen={screen}
          columns={columns}
          availableRows={Math.max(4, rows - top - 1)}
          top={top}
        />
      );
    }
    case "help":
      return <HelpOverlayView columns={columns} rows={rows} />;
    case "projectMenu":
      return (
        <ProjectMenuView
          screen={screen}
          columns={columns}
          rows={rows}
          anchorTop={projectMenuAnchorTop}
        />
      );
    case "createGroup":
      return <CreateGroupSheetView screen={screen} columns={columns} rows={rows} />;
    case "moveToGroup":
      return screen.step === "chooseSlot" ? null : (
        <MoveToGroupSheetView
          screen={screen}
          snapshot={snapshot}
          selection={selection}
          columns={columns}
          rows={rows}
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

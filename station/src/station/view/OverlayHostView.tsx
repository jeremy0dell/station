// OpenTUI port of apps/tui's OverlayHost: routes the active modal screen to
// its overlay (help panel, bottom sheets) in an absolute layer above the
// dashboard. The dashboard never reflows for overlays.
import type { StationSnapshot } from "@station/contracts";
import {
  tuiScreenClickAwayMode,
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

export type OverlayHostViewProps = {
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

export function OverlayHostView({
  snapshot,
  screen,
  selection,
  columns,
  rows,
  localRows,
  widgets = [],
  widgetsPersisted = true,
}: OverlayHostViewProps) {
  const dispatch = useStationMouse();
  let overlay: ReactNode = null;
  if (screen.name === "help") {
    overlay = <HelpOverlayView columns={columns} rows={rows} />;
  } else if (screen.name === "widgetSettings") {
    overlay = (
      <WidgetSettingsPanelView
        screen={screen}
        widgets={widgets}
        widgetsPersisted={widgetsPersisted}
        columns={columns}
        rows={rows}
      />
    );
  } else if (screen.name === "addProject") {
    overlay = (
      <AddProjectSheetView
        columns={columns}
        rows={rows}
        state={screen.flow}
        selection={selection}
      />
    );
  } else if (screen.name === "newSession") {
    overlay = (
      <NewSessionSheetView
        columns={columns}
        rows={rows}
        snapshot={snapshot}
        state={screen.flow}
        selection={selection}
      />
    );
  } else if (screen.name === "projectDefaultAgent") {
    overlay = (
      <ProjectDefaultAgentSheetView
        columns={columns}
        rows={rows}
        snapshot={snapshot}
        screen={screen}
        selection={selection}
      />
    );
  } else if (screen.name === "projectCollapse" || screen.name === "projectSettingsPicker") {
    overlay = (
      <ProjectChoiceSheetView
        columns={columns}
        rows={rows}
        snapshot={snapshot}
        mode={screen.name}
        selection={selection}
      />
    );
  } else if (screen.name === "renameSession" && screen.step === "editName") {
    overlay = <RenameSessionSheetView columns={columns} rows={rows} state={screen} />;
  } else if (screen.name === "removeWorktree") {
    overlay = <RemoveSessionSheetView columns={columns} rows={rows} screen={screen} />;
  } else if (screen.name === "projectSettings") {
    overlay = (
      <ProjectSettingsPanelView
        columns={columns}
        rows={rows}
        snapshot={snapshot}
        screen={screen}
        selection={selection}
        localRows={localRows}
      />
    );
  } else if (screen.name === "fork") {
    overlay = <ForkSessionSheetView columns={columns} rows={rows} screen={screen} />;
  }

  return (
    <>
      {tuiScreenClickAwayMode(screen) === "dismiss" ? (
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

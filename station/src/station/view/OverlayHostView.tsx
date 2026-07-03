// OpenTUI port of apps/tui's OverlayHost: routes the active modal screen to
// its overlay (help panel, bottom sheets) in an absolute layer above the
// dashboard. The dashboard never reflows for overlays.
import type { StationSnapshot } from "@station/contracts";
import type { TuiLocalRows, TuiScreen } from "@station/dashboard-core";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets/types";
import { AddProjectSheetView } from "./sheets/AddProjectSheetView.js";
import { HelpOverlayView } from "./HelpOverlayView.js";
import { NewSessionSheetView } from "./sheets/NewSessionSheetView.js";
import { ProjectDefaultAgentSheetView } from "./sheets/ProjectDefaultAgentSheetView.js";
import { ProjectSettingsPanelView } from "./settings/ProjectSettingsPanelView.js";
import { WidgetSettingsPanelView } from "./settings/WidgetSettingsPanelView.js";
import { RenameSessionSheetView } from "./sheets/RenameSessionSheetView.js";
import { RemoveSessionSheetView } from "./sheets/RemoveSessionSheetView.js";
import { ForkSessionSheetView } from "./sheets/ForkSessionSheetView.js";

export type OverlayHostViewProps = {
  snapshot: StationSnapshot;
  screen: TuiScreen;
  columns: number;
  rows: number;
  localRows: TuiLocalRows;
  /** Live session widget set for the widget-settings panel. */
  widgets?: readonly TuiWidgetConfig[];
  widgetsPersisted?: boolean;
};

export function OverlayHostView({
  snapshot,
  screen,
  columns,
  rows,
  localRows,
  widgets = [],
  widgetsPersisted = false,
}: OverlayHostViewProps) {
  if (screen.name === "help") {
    return <HelpOverlayView columns={columns} rows={rows} />;
  }
  if (screen.name === "widgetSettings") {
    return (
      <WidgetSettingsPanelView
        screen={screen}
        widgets={widgets}
        columns={columns}
        rows={rows}
        persisted={widgetsPersisted}
      />
    );
  }
  if (screen.name === "addProject") {
    return <AddProjectSheetView columns={columns} rows={rows} state={screen.flow} />;
  }
  if (screen.name === "newSession") {
    return (
      <NewSessionSheetView columns={columns} rows={rows} snapshot={snapshot} state={screen.flow} />
    );
  }
  if (screen.name === "projectDefaultAgent") {
    return (
      <ProjectDefaultAgentSheetView
        columns={columns}
        rows={rows}
        snapshot={snapshot}
        screen={screen}
      />
    );
  }
  if (screen.name === "renameSession" && screen.step === "editName") {
    return <RenameSessionSheetView columns={columns} rows={rows} state={screen} />;
  }
  if (screen.name === "removeWorktree") {
    return <RemoveSessionSheetView columns={columns} rows={rows} screen={screen} />;
  }
  if (screen.name === "projectSettings") {
    return (
      <ProjectSettingsPanelView
        columns={columns}
        rows={rows}
        snapshot={snapshot}
        screen={screen}
        localRows={localRows}
      />
    );
  }
  if (screen.name === "fork") {
    return <ForkSessionSheetView columns={columns} rows={rows} screen={screen} />;
  }
  return null;
}

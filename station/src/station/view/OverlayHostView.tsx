// OpenTUI port of apps/tui's OverlayHost: routes the active modal screen to
// its overlay (help panel, bottom sheets) in an absolute layer above the
// dashboard. The dashboard never reflows for overlays.
import type { StationSnapshot } from "@station/contracts";
import type { TuiScreen } from "@station/dashboard-core";
import { AddProjectSheetView } from "./sheets/AddProjectSheetView.js";
import { HelpOverlayView } from "./HelpOverlayView.js";
import { NewSessionSheetView } from "./sheets/NewSessionSheetView.js";
import { ProjectDefaultAgentSheetView } from "./sheets/ProjectDefaultAgentSheetView.js";
import { ProjectSettingsPanelView } from "./settings/ProjectSettingsPanelView.js";
import { RenameSessionSheetView } from "./sheets/RenameSessionSheetView.js";
import { RemoveSessionSheetView } from "./sheets/RemoveSessionSheetView.js";
import { ForkSessionSheetView } from "./sheets/ForkSessionSheetView.js";

export type OverlayHostViewProps = {
  snapshot: StationSnapshot;
  screen: TuiScreen;
  columns: number;
  rows: number;
};

export function OverlayHostView({ snapshot, screen, columns, rows }: OverlayHostViewProps) {
  if (screen.name === "help") {
    return <HelpOverlayView columns={columns} rows={rows} />;
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
      <ProjectSettingsPanelView columns={columns} rows={rows} snapshot={snapshot} screen={screen} />
    );
  }
  if (screen.name === "fork") {
    return <ForkSessionSheetView columns={columns} rows={rows} screen={screen} />;
  }
  return null;
}

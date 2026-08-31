import type { ProjectId } from "@station/contracts";
import type { DashboardSnapshotView } from "../state/types.js";
import { type SelectionChoice, selectionChoices } from "./keyedChoices.js";

type DashboardProjectView = DashboardSnapshotView["projects"][number];

/**
 * The project choosers (collapse / settings) list every project in snapshot
 * order, unaffected by search or collapse — so the engine spec and the sheet
 * view can key off the snapshot alone and stay in exact agreement.
 */
export function selectProjectChooserChoices(
  snapshot: DashboardSnapshotView,
): Array<SelectionChoice<DashboardProjectView>> {
  return selectionChoices(snapshot.projects);
}

export function selectNewSessionProject(
  snapshot: DashboardSnapshotView,
  selectedProjectId: ProjectId,
): DashboardProjectView | undefined {
  return (
    snapshot.projects.find((project) => project.id === selectedProjectId) ?? snapshot.projects[0]
  );
}

export function selectNewSessionProjectChoices(
  snapshot: DashboardSnapshotView,
): Array<SelectionChoice<DashboardProjectView>> {
  return selectionChoices(snapshot.projects);
}

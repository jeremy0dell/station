import type { ProjectId, SessionGroupId, SessionId } from "@station/contracts";
import type { DashboardSnapshotView } from "../state/types.js";
import { type SelectionChoice, selectionChoices } from "./keyedChoices.js";

export type NewSessionGroupOption = DashboardSnapshotView["sessionGroups"][number];
export type MoveToGroupSessionContext = {
  session: DashboardSnapshotView["sessions"][number];
  project: DashboardSnapshotView["projects"][number];
  currentGroup?: NewSessionGroupOption;
};

export function selectNewSessionGroupChoices(
  snapshot: DashboardSnapshotView,
  projectId: ProjectId,
): Array<SelectionChoice<NewSessionGroupOption>> {
  return selectionChoices(
    snapshot.sessionGroups.filter(
      (group) => group.projectId === projectId && group.parentGroupId === undefined,
    ),
  );
}

export function selectNewSessionRootGroup(
  snapshot: DashboardSnapshotView,
  projectId: ProjectId,
  groupId: SessionGroupId,
): NewSessionGroupOption | undefined {
  return snapshot.sessionGroups.find(
    (group) =>
      group.id === groupId && group.projectId === projectId && group.parentGroupId === undefined,
  );
}

/** Resolves the latest canonical session, Project, and exclusive Group membership. */
export function selectMoveToGroupSessionContext(
  snapshot: DashboardSnapshotView,
  sessionId: SessionId,
): MoveToGroupSessionContext | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return undefined;
  const project = snapshot.projects.find((candidate) => candidate.id === session.projectId);
  if (project === undefined) return undefined;
  const currentGroup = snapshot.sessionGroups.find((group) => group.sessionIds.includes(sessionId));
  const context: MoveToGroupSessionContext = { session, project };
  if (currentGroup !== undefined) context.currentGroup = currentGroup;
  return context;
}

export function selectMoveToGroupChoices(
  snapshot: DashboardSnapshotView,
  sessionId: SessionId,
): Array<SelectionChoice<NewSessionGroupOption>> {
  const context = selectMoveToGroupSessionContext(snapshot, sessionId);
  return context === undefined ? [] : selectNewSessionGroupChoices(snapshot, context.project.id);
}

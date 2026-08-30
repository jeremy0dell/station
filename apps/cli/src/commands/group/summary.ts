import type {
  ProjectId,
  SafeError,
  SessionGroupId,
  SessionGroupView,
  SessionId,
  StationSnapshot,
} from "@station/contracts";

export type GroupFilters = {
  project?: ProjectId;
};

export function projectGroups(
  snapshot: StationSnapshot,
  projectId?: ProjectId,
): SessionGroupView[] {
  return snapshot.sessionGroups
    .filter((group) => projectId === undefined || group.projectId === projectId)
    .map(projectGroup);
}

export function findGroup(snapshot: StationSnapshot, groupId: SessionGroupId): SessionGroupView {
  const group = snapshot.sessionGroups.find((candidate) => candidate.id === groupId);
  if (group === undefined) throw groupNotFoundError(groupId);
  return projectGroup(group);
}

export function findSession(
  snapshot: StationSnapshot,
  sessionId: SessionId,
): StationSnapshot["sessions"][number] {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw sessionNotFoundError(sessionId);
  return session;
}

export function sessionMemberships(snapshot: StationSnapshot): Map<SessionId, SessionGroupId> {
  const memberships = new Map<SessionId, SessionGroupId>();
  for (const group of snapshot.sessionGroups) {
    for (const sessionId of group.sessionIds) memberships.set(sessionId, group.id);
  }
  return memberships;
}

export function sameSessionIds(left: readonly SessionId[], right: readonly SessionId[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((sessionId) => expected.has(sessionId));
}

export function assertProject(snapshot: StationSnapshot, projectId: ProjectId): void {
  if (!snapshot.projects.some((project) => project.id === projectId)) {
    throw groupProjectNotFoundError(projectId);
  }
}

export function assertSessionProject(
  sessionProjectId: ProjectId,
  projectId: ProjectId,
  sessionId: SessionId,
): void {
  if (sessionProjectId === projectId) return;
  throw {
    tag: "GroupCliError",
    code: "GROUP_SESSION_PROJECT_MISMATCH",
    message: `session ${sessionId} does not belong to project ${projectId}.`,
    hint: "Session Groups only contain same-project sessions and parents.",
    projectId,
    sessionId,
  } satisfies SafeError;
}

export function assertParentProject(
  parentProjectId: ProjectId,
  projectId: ProjectId,
  parentGroupId: SessionGroupId,
): void {
  if (parentProjectId === projectId) return;
  throw {
    tag: "GroupCliError",
    code: "GROUP_PARENT_PROJECT_MISMATCH",
    message: `parent Group ${parentGroupId} does not belong to project ${projectId}.`,
    hint: "Session Groups only contain same-project sessions and parents.",
    projectId,
  } satisfies SafeError;
}

function projectGroup(group: SessionGroupView): SessionGroupView {
  return structuredClone(group);
}

function groupProjectNotFoundError(projectId: ProjectId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_PROJECT_NOT_FOUND",
    message: `No current project has the exact id ${projectId}.`,
    hint: "Use `stn project list` or `stn group list` and retry with a configured project id.",
    projectId,
  };
}

function groupNotFoundError(groupId: SessionGroupId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_NOT_FOUND",
    message: `No current Session Group has the exact id ${groupId}.`,
    hint: "Use `stn group list` and pass one complete current Group id.",
  };
}

function sessionNotFoundError(sessionId: SessionId): SafeError {
  return {
    tag: "GroupCliError",
    code: "GROUP_SESSION_NOT_FOUND",
    message: `No current session has the exact id ${sessionId}.`,
    hint: "Use `stn session list` and pass one complete current session id.",
    sessionId,
  };
}

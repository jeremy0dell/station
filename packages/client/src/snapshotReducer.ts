import type {
  SessionGroupView,
  SessionView,
  StationEvent,
  StationSnapshot,
  WorktreeRow,
} from "@station/contracts";
import { StationSnapshotSchema, worktreeDisplayForAgentState } from "@station/contracts";
import { safeErrorToNotice } from "./errors.js";
import type { ApplyStationEventResult } from "./types.js";

type OptionalPatch<T> = {
  [K in keyof T]?: T[K] | undefined;
};

/**
 * Reduce relationship-safe events immediately and signal when the client must
 * replace its state from a canonical snapshot, including unsequenced additions
 * and ambiguous Group changes.
 */
export function applyStationEvent(
  snapshot: StationSnapshot,
  event: StationEvent,
): ApplyStationEventResult {
  if (event.type === "worktree.added") {
    return unchanged(snapshot, true);
  }
  if (event.type === "worktree.updated") {
    return withSnapshot(snapshot, {
      rows: snapshot.rows.map((row) =>
        row.id === event.worktreeId ? mergeRowPatch(row, event.patch) : row,
      ),
    });
  }
  if (event.type === "worktree.removed") {
    const removedSessionIds = new Set(
      snapshot.sessions
        .filter((session) => session.worktreeId === event.worktreeId)
        .map((session) => session.id),
    );
    const sessionGroups = withoutGroupMembers(snapshot.sessionGroups, removedSessionIds);
    return withSnapshot(
      snapshot,
      {
        rows: snapshot.rows.filter((row) => row.id !== event.worktreeId),
        sessions: snapshot.sessions.filter((session) => session.worktreeId !== event.worktreeId),
        sessionGroups,
      },
      sessionGroups !== snapshot.sessionGroups,
    );
  }
  if (event.type === "worktree.agentStateChanged") {
    return withSnapshot(snapshot, {
      rows: snapshot.rows.map((row) =>
        row.id === event.worktreeId ? rowForAgentState(row, event.agent) : row,
      ),
    });
  }
  if (event.type === "session.created") {
    return unchanged(snapshot, true);
  }
  if (event.type === "session.updated") {
    return withSnapshot(
      snapshot,
      {
        sessions: snapshot.sessions.map((session) =>
          session.id === event.sessionId ? mergeSessionPatch(session, event.patch) : session,
        ),
      },
      true,
    );
  }
  if (event.type === "session.removed") {
    return withSnapshot(
      snapshot,
      {
        sessions: snapshot.sessions.filter((session) => session.id !== event.sessionId),
        sessionGroups: withoutGroupMembers(snapshot.sessionGroups, new Set([event.sessionId])),
      },
      true,
    );
  }
  if (event.type === "sessionGroup.updated") {
    return applySessionGroupUpdated(snapshot, event.group);
  }
  if (event.type === "sessionGroup.removed") {
    const existing = snapshot.sessionGroups.find((group) => group.id === event.groupId);
    if (existing === undefined) {
      return unchanged(snapshot);
    }
    const candidate = {
      ...snapshot,
      sessionGroups: snapshot.sessionGroups.filter((group) => group.id !== event.groupId),
    };
    return StationSnapshotSchema.safeParse(candidate).success
      ? unchanged(candidate)
      : unchanged(snapshot, true);
  }
  if (event.type === "provider.healthChanged") {
    return {
      snapshot: {
        ...snapshot,
        providerHealth: {
          ...snapshot.providerHealth,
          [event.provider]: event.health,
        },
      },
      needsSnapshotRefresh: true,
      notices: [],
    };
  }
  if (event.type === "command.failed") {
    if (
      event.error.code === "SESSION_GROUP_VERSION_CONFLICT" ||
      event.error.code === "SESSION_GROUP_ASSIGNMENT_CONFLICT"
    ) {
      return unchanged(snapshot, true);
    }
    return {
      snapshot,
      needsSnapshotRefresh: false,
      notices: [safeErrorToNotice(event.error)],
    };
  }
  if (
    event.type === "observer.reconciled" ||
    event.type === "project.updated" ||
    event.type === "providerHook.ingested" ||
    event.type === "providerHook.spoolDrained"
  ) {
    return {
      snapshot,
      needsSnapshotRefresh: true,
      notices: [],
    };
  }
  return {
    snapshot,
    needsSnapshotRefresh: false,
    notices: [],
  };
}

function withSnapshot(
  snapshot: StationSnapshot,
  patch: Partial<Pick<StationSnapshot, "rows" | "sessions" | "sessionGroups">>,
  needsSnapshotRefresh = false,
): ApplyStationEventResult {
  const nextSnapshot: StationSnapshot = {
    ...snapshot,
    rows: patch.rows ?? snapshot.rows,
    sessions: patch.sessions ?? snapshot.sessions,
    sessionGroups: patch.sessionGroups ?? snapshot.sessionGroups,
  };
  return {
    snapshot: nextSnapshot,
    needsSnapshotRefresh,
    notices: [],
  };
}

function applySessionGroupUpdated(
  snapshot: StationSnapshot,
  group: SessionGroupView,
): ApplyStationEventResult {
  const existingIndex = snapshot.sessionGroups.findIndex((candidate) => candidate.id === group.id);
  if (existingIndex === -1) {
    return unchanged(snapshot, true);
  }
  const existing = snapshot.sessionGroups[existingIndex];
  if (existing === undefined) {
    return unchanged(snapshot, true);
  }
  if (group.version < existing.version) {
    return unchanged(snapshot);
  }
  if (group.version === existing.version) {
    return sameSessionGroup(existing, group) ? unchanged(snapshot) : unchanged(snapshot, true);
  }
  if (!sameSessionGroupRelationships(existing, group)) {
    return unchanged(snapshot, true);
  }

  const sessionGroups = [...snapshot.sessionGroups];
  sessionGroups[existingIndex] = group;
  const candidate = { ...snapshot, sessionGroups };
  return StationSnapshotSchema.safeParse(candidate).success
    ? unchanged(candidate)
    : unchanged(snapshot, true);
}

function sameSessionGroup(left: SessionGroupView, right: SessionGroupView): boolean {
  return (
    sameSessionGroupRelationships(left, right) &&
    left.name === right.name &&
    left.version === right.version &&
    left.updatedAt === right.updatedAt
  );
}

function sameSessionGroupRelationships(left: SessionGroupView, right: SessionGroupView): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.createdAt === right.createdAt &&
    left.parentGroupId === right.parentGroupId &&
    left.sessionIds.length === right.sessionIds.length &&
    left.sessionIds.every((sessionId, index) => sessionId === right.sessionIds[index])
  );
}

function withoutGroupMembers(
  groups: SessionGroupView[],
  removedSessionIds: ReadonlySet<string>,
): SessionGroupView[] {
  if (removedSessionIds.size === 0) {
    return groups;
  }
  let changed = false;
  const next = groups.map((group) => {
    const sessionIds = group.sessionIds.filter((sessionId) => !removedSessionIds.has(sessionId));
    if (sessionIds.length === group.sessionIds.length) {
      return group;
    }
    changed = true;
    return { ...group, sessionIds };
  });
  return changed ? next : groups;
}

function unchanged(
  snapshot: StationSnapshot,
  needsSnapshotRefresh = false,
): ApplyStationEventResult {
  return { snapshot, needsSnapshotRefresh, notices: [] };
}

function mergeRowPatch(row: WorktreeRow, patch: OptionalPatch<WorktreeRow>): WorktreeRow {
  const next: WorktreeRow = {
    id: patch.id ?? row.id,
    projectId: patch.projectId ?? row.projectId,
    projectLabel: patch.projectLabel ?? row.projectLabel,
    title: patch.title ?? row.title,
    branch: patch.branch ?? row.branch,
    path: patch.path ?? row.path,
    worktree: row.worktree,
    display: row.display,
  };
  if (row.terminal !== undefined) next.terminal = row.terminal;
  if (row.agent !== undefined) next.agent = row.agent;
  if (patch.worktree !== undefined) next.worktree = { ...row.worktree, ...patch.worktree };
  if ("terminal" in patch) {
    if (patch.terminal === undefined) {
      delete next.terminal;
    } else {
      next.terminal = { ...row.terminal, ...patch.terminal };
    }
  }
  if ("agent" in patch) {
    if (patch.agent === undefined) {
      delete next.agent;
    } else {
      next.agent = patch.agent;
    }
  }
  if (patch.display !== undefined) next.display = { ...row.display, ...patch.display };
  return next;
}

function rowForAgentState(row: WorktreeRow, agent: WorktreeRow["agent"]): WorktreeRow {
  const display = worktreeDisplayForAgentState(agent?.state);
  if (agent === undefined) {
    display.reason = "No harness run is associated with this worktree.";
  } else if (display.alert || display.warning === true) {
    display.reason = agent.reason;
  }
  const next = { ...row, display };
  if (agent === undefined) {
    delete next.agent;
  } else {
    next.agent = agent;
  }
  return next;
}

function mergeSessionPatch(session: SessionView, patch: OptionalPatch<SessionView>): SessionView {
  const next: SessionView = {
    id: patch.id ?? session.id,
    origin: patch.origin ?? session.origin,
    projectId: patch.projectId ?? session.projectId,
    worktreeId: patch.worktreeId ?? session.worktreeId,
    createdAt: patch.createdAt ?? session.createdAt,
    updatedAt: patch.updatedAt ?? session.updatedAt,
    harness: session.harness,
    status: session.status,
    title: patch.title ?? session.title,
    tags: patch.tags ?? session.tags,
  };
  if (session.terminal !== undefined) next.terminal = session.terminal;
  if (patch.harness !== undefined) next.harness = { ...session.harness, ...patch.harness };
  if (patch.terminal !== undefined) {
    next.terminal =
      session.terminal === undefined ? patch.terminal : { ...session.terminal, ...patch.terminal };
  }
  if (patch.status !== undefined) next.status = { ...session.status, ...patch.status };
  return next;
}

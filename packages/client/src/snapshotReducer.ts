import type { SessionView, StationEvent, StationSnapshot, WorktreeRow } from "@station/contracts";
import { safeErrorToNotice } from "./errors.js";
import type { ApplyStationEventResult } from "./types.js";

type OptionalPatch<T> = {
  [K in keyof T]?: T[K] | undefined;
};

export function applyStationEvent(
  snapshot: StationSnapshot,
  event: StationEvent,
): ApplyStationEventResult {
  if (event.type === "worktree.added") {
    return withSnapshot(snapshot, { rows: [...snapshot.rows, event.row] });
  }
  if (event.type === "worktree.updated") {
    return withSnapshot(snapshot, {
      rows: snapshot.rows.map((row) =>
        row.id === event.worktreeId ? mergeRowPatch(row, event.patch) : row,
      ),
    });
  }
  if (event.type === "worktree.removed") {
    return withSnapshot(snapshot, {
      rows: snapshot.rows.filter((row) => row.id !== event.worktreeId),
      sessions: snapshot.sessions.filter((session) => session.worktreeId !== event.worktreeId),
    });
  }
  if (event.type === "worktree.agentStateChanged") {
    return withSnapshot(snapshot, {
      rows: snapshot.rows.map((row) =>
        row.id === event.worktreeId ? mergeRowPatch(row, rowPatchForAgentState(event.agent)) : row,
      ),
    });
  }
  if (event.type === "session.created") {
    return withSnapshot(
      snapshot,
      { sessions: upsertSession(snapshot.sessions, event.session) },
      true,
    );
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
      },
      true,
    );
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
  patch: Partial<Pick<StationSnapshot, "rows" | "sessions">>,
  needsSnapshotRefresh = false,
): ApplyStationEventResult {
  const nextSnapshot: StationSnapshot = {
    ...snapshot,
    rows: patch.rows ?? snapshot.rows,
    sessions: patch.sessions ?? snapshot.sessions,
  };
  return {
    snapshot: nextSnapshot,
    needsSnapshotRefresh,
    notices: [],
  };
}

function mergeRowPatch(row: WorktreeRow, patch: OptionalPatch<WorktreeRow>): WorktreeRow {
  const next: WorktreeRow = {
    id: patch.id ?? row.id,
    projectId: patch.projectId ?? row.projectId,
    projectLabel: patch.projectLabel ?? row.projectLabel,
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

function rowPatchForAgentState(agent: WorktreeRow["agent"]): OptionalPatch<WorktreeRow> {
  if (agent === undefined) {
    return {
      agent,
      display: {
        statusLabel: "no agent",
        sortPriority: 70,
        alert: false,
        reason: "No harness run is associated with this worktree.",
      },
    };
  }

  const display = displayForAgent(agent);
  return {
    agent,
    display,
  };
}

function displayForAgent(agent: NonNullable<WorktreeRow["agent"]>): WorktreeRow["display"] {
  if (agent.state === "needs_attention") {
    return {
      statusLabel: "needs attention",
      sortPriority: 10,
      alert: true,
      reason: agent.reason,
    };
  }
  if (agent.state === "stuck") {
    return {
      statusLabel: "stuck",
      sortPriority: 20,
      alert: true,
      warning: true,
      reason: agent.reason,
    };
  }
  if (agent.state === "working") {
    return {
      statusLabel: "working",
      sortPriority: 30,
      alert: false,
    };
  }
  if (agent.state === "starting") {
    return {
      statusLabel: "starting",
      sortPriority: 35,
      alert: false,
    };
  }
  if (agent.state === "idle") {
    return {
      statusLabel: "idle",
      sortPriority: 40,
      alert: false,
    };
  }
  if (agent.state === "exited") {
    return {
      statusLabel: "exited",
      sortPriority: 60,
      alert: false,
    };
  }
  return {
    statusLabel: "unknown",
    sortPriority: 50,
    alert: false,
  };
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

function upsertSession(sessions: readonly SessionView[], session: SessionView): SessionView[] {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [...sessions, session];
  }
  return sessions.map((candidate) => (candidate.id === session.id ? session : candidate));
}

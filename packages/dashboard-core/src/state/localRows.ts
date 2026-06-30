import type {
  CommandId,
  ProjectId,
  ProviderId,
  SafeError,
  SessionId,
  StationSnapshot,
  WorktreeId,
} from "@station/contracts";
import type { TuiState } from "./types.js";

export type PendingCreateSessionRow = {
  localId: string;
  projectId: string;
  branch: string;
  harnessProvider?: ProviderId;
  createdAt: string;
  commandId?: CommandId;
};

export type FailedCreateSessionRow = {
  localId: string;
  projectId: string;
  branch: string;
  error: SafeError;
  expiresAt: number;
};

export type PendingRemoveWorktreeRow = {
  localId: string;
  projectId: string;
  worktreeId: WorktreeId;
  branch: string;
  createdAt: string;
  commandId?: CommandId;
};

export type PendingStartAgentRow = {
  localId: string;
  operation?: "startAgent" | "resumeAgent";
  projectId: string;
  worktreeId: WorktreeId;
  branch: string;
  createdAt: string;
  commandId?: CommandId;
};

export type PendingRenameSessionTitle = {
  sessionId: SessionId;
  title: string;
  createdAt: string;
  commandId?: CommandId;
};

/**
 * Optimistic "default agent" change for a project: the picked harness shown as
 * current before the observer round-trip lands. Pruned when the snapshot's
 * default matches, removed (reverted) if the command fails.
 */
export type PendingProjectDefaultHarness = {
  projectId: ProjectId;
  harness: ProviderId;
  createdAt: string;
};

export type TuiLocalRows = {
  pendingCreate: PendingCreateSessionRow[];
  failedCreate: FailedCreateSessionRow[];
  pendingRemove: PendingRemoveWorktreeRow[];
  pendingStart: PendingStartAgentRow[];
  pendingRenameTitles?: Readonly<Record<SessionId, PendingRenameSessionTitle>>;
  pendingProjectDefaults?: Readonly<Record<ProjectId, PendingProjectDefaultHarness>>;
};

export function createEmptyTuiLocalRows(): TuiLocalRows {
  return {
    pendingCreate: [],
    failedCreate: [],
    pendingRemove: [],
    pendingStart: [],
    pendingRenameTitles: {},
    pendingProjectDefaults: {},
  };
}

export function addPendingCreateSessionRow(
  state: TuiState,
  row: PendingCreateSessionRow,
): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingCreate: [
        ...state.localRows.pendingCreate.filter((candidate) => candidate.localId !== row.localId),
        row,
      ],
    },
  };
}

export function bindPendingCreateSessionRow(
  state: TuiState,
  localId: string,
  commandId: CommandId,
): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingCreate: state.localRows.pendingCreate.map((row) => {
        if (row.localId !== localId) {
          return row;
        }
        return { ...row, commandId };
      }),
    },
  };
}

export function failPendingCreateSessionRow(
  state: TuiState,
  localId: string,
  error: SafeError,
  expiresAt: number,
): TuiState {
  const row = state.localRows.pendingCreate.find((candidate) => candidate.localId === localId);
  if (row === undefined) {
    return state;
  }
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingCreate: state.localRows.pendingCreate.filter(
        (candidate) => candidate.localId !== localId,
      ),
      failedCreate: [
        ...state.localRows.failedCreate,
        {
          localId,
          projectId: row.projectId,
          branch: row.branch,
          error,
          expiresAt,
        },
      ],
    },
  };
}

export function removeCreateSessionLocalRow(state: TuiState, localId: string): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingCreate: state.localRows.pendingCreate.filter((row) => row.localId !== localId),
      failedCreate: state.localRows.failedCreate.filter((row) => row.localId !== localId),
    },
  };
}

export function addPendingRemoveWorktreeRow(
  state: TuiState,
  row: PendingRemoveWorktreeRow,
): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingRemove: [
        ...state.localRows.pendingRemove.filter(
          (candidate) => candidate.worktreeId !== row.worktreeId,
        ),
        row,
      ],
    },
  };
}

export function bindPendingRemoveWorktreeRow(
  state: TuiState,
  localId: string,
  commandId: CommandId,
): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingRemove: state.localRows.pendingRemove.map((row) => {
        if (row.localId !== localId) {
          return row;
        }
        return { ...row, commandId };
      }),
    },
  };
}

export function removePendingRemoveWorktreeRow(state: TuiState, localId: string): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingRemove: state.localRows.pendingRemove.filter((row) => row.localId !== localId),
    },
  };
}

export function addPendingStartAgentRow(state: TuiState, row: PendingStartAgentRow): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingStart: [
        ...state.localRows.pendingStart.filter(
          (candidate) => candidate.worktreeId !== row.worktreeId,
        ),
        row,
      ],
    },
  };
}

export function bindPendingStartAgentRow(
  state: TuiState,
  localId: string,
  commandId: CommandId,
): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingStart: state.localRows.pendingStart.map((row) => {
        if (row.localId !== localId) {
          return row;
        }
        return { ...row, commandId };
      }),
    },
  };
}

export function removePendingStartAgentRow(state: TuiState, localId: string): TuiState {
  return {
    ...state,
    localRows: {
      ...state.localRows,
      pendingStart: state.localRows.pendingStart.filter((row) => row.localId !== localId),
    },
  };
}

export function addPendingRenameSessionTitle(
  state: TuiState,
  row: PendingRenameSessionTitle,
): TuiState {
  return {
    ...state,
    localRows: withPendingRenameTitles(state.localRows, {
      ...pendingRenameTitles(state.localRows),
      [row.sessionId]: row,
    }),
  };
}

export function bindPendingRenameSessionTitle(
  state: TuiState,
  sessionId: SessionId,
  commandId: CommandId,
): TuiState {
  const pending = state.localRows.pendingRenameTitles?.[sessionId];
  if (pending === undefined) {
    return state;
  }
  return {
    ...state,
    localRows: withPendingRenameTitles(state.localRows, {
      ...pendingRenameTitles(state.localRows),
      [sessionId]: {
        ...pending,
        commandId,
      },
    }),
  };
}

export function removePendingRenameSessionTitle(state: TuiState, sessionId: SessionId): TuiState {
  const pending = pendingRenameTitles(state.localRows);
  if (pending[sessionId] === undefined) {
    return state;
  }
  const nextPending = { ...pending };
  delete nextPending[sessionId];
  return {
    ...state,
    localRows: withPendingRenameTitles(state.localRows, nextPending),
  };
}

export function addPendingProjectDefaultHarness(
  state: TuiState,
  row: PendingProjectDefaultHarness,
): TuiState {
  return {
    ...state,
    localRows: withPendingProjectDefaults(state.localRows, {
      ...pendingProjectDefaultHarnesses(state.localRows),
      [row.projectId]: row,
    }),
  };
}

export function removePendingProjectDefaultHarness(
  state: TuiState,
  projectId: ProjectId,
): TuiState {
  const pending = pendingProjectDefaultHarnesses(state.localRows);
  if (pending[projectId] === undefined) {
    return state;
  }
  const nextPending = { ...pending };
  delete nextPending[projectId];
  return {
    ...state,
    localRows: withPendingProjectDefaults(state.localRows, nextPending),
  };
}

export function pendingProjectDefaultHarnesses(
  localRows: TuiLocalRows,
): Readonly<Record<ProjectId, PendingProjectDefaultHarness>> {
  return localRows.pendingProjectDefaults ?? {};
}

export function pruneLocalRowsForSnapshot(
  localRows: TuiLocalRows,
  snapshot: StationSnapshot,
): TuiLocalRows {
  const realRows = new Set(snapshot.rows.map((row) => `${row.projectId}\u0000${row.branch}`));
  const realWorktreeIds = new Set(snapshot.rows.map((row) => row.id));
  const rowsByWorktreeId = new Map(snapshot.rows.map((row) => [row.id, row]));
  const sessionWorktreeIds = new Set(snapshot.sessions.map((session) => session.worktreeId));
  const pruned = withPendingRenameTitles(
    {
      ...localRows,
      pendingCreate: localRows.pendingCreate.filter(
        (row) => !realRows.has(`${row.projectId}\u0000${row.branch}`),
      ),
      pendingRemove: localRows.pendingRemove.filter((row) => realWorktreeIds.has(row.worktreeId)),
      pendingStart: localRows.pendingStart.filter((row) => {
        const realRow = rowsByWorktreeId.get(row.worktreeId);
        return (
          realRow !== undefined &&
          realRow.agent === undefined &&
          !sessionWorktreeIds.has(row.worktreeId)
        );
      }),
    },
    prunePendingRenameTitles(localRows, snapshot),
  );
  return withPendingProjectDefaults(pruned, prunePendingProjectDefaults(localRows, snapshot));
}

export function pendingRenameTitles(
  localRows: TuiLocalRows,
): Readonly<Record<SessionId, PendingRenameSessionTitle>> {
  return localRows.pendingRenameTitles ?? {};
}

function prunePendingRenameTitles(
  localRows: TuiLocalRows,
  snapshot: StationSnapshot,
): Record<SessionId, PendingRenameSessionTitle> {
  const sessionsById = new Map(snapshot.sessions.map((session) => [session.id, session]));
  return Object.fromEntries(
    Object.entries(pendingRenameTitles(localRows)).filter(([sessionId, pending]) => {
      const session = sessionsById.get(sessionId);
      return session !== undefined && session.title !== pending.title;
    }),
  );
}

function withPendingRenameTitles(
  localRows: TuiLocalRows,
  titles: Readonly<Record<SessionId, PendingRenameSessionTitle>>,
): TuiLocalRows {
  const next: TuiLocalRows = {
    ...localRows,
  };
  if (Object.keys(titles).length > 0) {
    next.pendingRenameTitles = titles;
  } else {
    delete next.pendingRenameTitles;
  }
  return next;
}

function prunePendingProjectDefaults(
  localRows: TuiLocalRows,
  snapshot: StationSnapshot,
): Record<ProjectId, PendingProjectDefaultHarness> {
  const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
  return Object.fromEntries(
    Object.entries(pendingProjectDefaultHarnesses(localRows)).filter(([projectId, pending]) => {
      const project = projectsById.get(projectId);
      return project !== undefined && project.defaults.harness !== pending.harness;
    }),
  );
}

function withPendingProjectDefaults(
  localRows: TuiLocalRows,
  defaults: Readonly<Record<ProjectId, PendingProjectDefaultHarness>>,
): TuiLocalRows {
  const next: TuiLocalRows = {
    ...localRows,
  };
  if (Object.keys(defaults).length > 0) {
    next.pendingProjectDefaults = defaults;
  } else {
    delete next.pendingProjectDefaults;
  }
  return next;
}

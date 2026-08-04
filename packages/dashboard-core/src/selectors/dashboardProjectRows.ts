import { worktreeRowVisibleFields } from "../components/WorktreeRow/rowInput.js";
import type { DashboardSnapshotView, DashboardViewState } from "../state/types.js";
import type {
  DashboardPersistentFilterCandidate,
  DashboardPersistentFilterProjection,
  DashboardPersistentFilterRowMatch,
  DashboardPersistentFilterVisibleFields,
} from "./dashboardPersistentFilter.js";
import {
  type DashboardSessionRow,
  selectProjectGroups,
  sessionRowDisplayTitle,
} from "./dashboardSessionRows.js";

type DashboardProjectView = DashboardSnapshotView["projects"][number];
type DashboardPendingCreateSessionRowView =
  DashboardViewState["localRows"]["pendingCreate"][number];
type DashboardFailedCreateSessionRowView = DashboardViewState["localRows"]["failedCreate"][number];
type DashboardPendingRemoveWorktreeRowView =
  DashboardViewState["localRows"]["pendingRemove"][number];
type DashboardPendingStartAgentRowView = DashboardViewState["localRows"]["pendingStart"][number];

type DashboardCreateSessionLocalRow =
  | ({ readonly status: "pending" } & DashboardPendingCreateSessionRowView)
  | ({ readonly status: "failed" } & DashboardFailedCreateSessionRowView);

export type DashboardSessionItem = {
  type: "session";
  id: string;
  row: DashboardSessionRow;
  displayTitle: string;
  presentation: DashboardPersistentFilterVisibleFields;
  pendingRemove?: DashboardPendingRemoveWorktreeRowView;
  pendingStart?: DashboardPendingStartAgentRowView;
  persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

export type DashboardCreateLocalItem = {
  type: "createLocalRow";
  id: string;
  row: DashboardCreateSessionLocalRow;
  presentation: DashboardPersistentFilterVisibleFields;
  persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

export type DashboardRowItem = DashboardSessionItem | DashboardCreateLocalItem;

export type DashboardProjectRowGroup = {
  project: DashboardProjectView;
  collapsed: boolean;
  rows: DashboardRowItem[];
};

type GroupDashboardRow =
  | {
      type: "session";
      row: DashboardSessionRow;
    }
  | {
      type: "createLocalRow";
      row: DashboardCreateSessionLocalRow;
    };

export function selectDashboardProjectRowGroups(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
): DashboardProjectRowGroup[] {
  const localRows = visibleCreateSessionLocalRows(snapshot, state);
  return selectProjectGroups(snapshot, state, {
    includeCollapsedRows: true,
  }).map((group) => ({
    project: group.project,
    collapsed: group.collapsed,
    rows: projectRows(group.rows, group.project, localRows, state),
  }));
}

export function persistentFilterCandidateForDashboardRow(
  item: DashboardRowItem,
): DashboardPersistentFilterCandidate {
  if (item.type === "session") {
    return {
      kind: "session",
      id: item.id,
      projectId: item.row.worktree.projectId,
      visibleFields: item.presentation,
      conditionValues: {
        status: item.pendingStart === undefined ? item.row.session.status.value : "starting",
        agent: item.row.session.harness.provider,
      },
    };
  }
  const conditionValues: DashboardPersistentFilterCandidate["conditionValues"] = {};
  if (item.row.status === "pending") {
    conditionValues.status = "starting";
    if (item.row.harnessProvider !== undefined) {
      conditionValues.agent = item.row.harnessProvider;
    }
  }
  return {
    kind: "optimistic",
    id: item.id,
    projectId: item.row.projectId,
    visibleFields: item.presentation,
    conditionValues,
  };
}

export function withDashboardRowFilterMatch(
  item: DashboardRowItem,
  projection: DashboardPersistentFilterProjection,
): DashboardRowItem {
  const match = projection.rows.get(item.id);
  return match === undefined ? item : { ...item, persistentFilterMatch: match };
}

function projectRows(
  sessionRows: readonly DashboardSessionRow[],
  project: DashboardProjectView,
  localRows: readonly DashboardCreateSessionLocalRow[],
  state: DashboardViewState,
): DashboardRowItem[] {
  const projectLocalRows = localRows.filter((row) => row.projectId === project.id);
  return mergeDashboardRows(sessionRows, projectLocalRows, state).map((row) =>
    row.type === "session" ? sessionItem(row.row, state) : createLocalItem(row.row),
  );
}

function sessionItem(row: DashboardSessionRow, state: DashboardViewState): DashboardSessionItem {
  const displayTitle = sessionRowDisplayTitle(row, state.localRows);
  const pendingRemove = state.localRows.pendingRemove.find(
    (localRow) => localRow.worktreeId === row.worktree.id,
  );
  const pendingStart = state.localRows.pendingStart.find(
    (localRow) => localRow.worktreeId === row.worktree.id,
  );
  const item: DashboardSessionItem = {
    type: "session",
    id: `session:${row.id}`,
    row,
    displayTitle,
    presentation: sessionRowPresentation(row, displayTitle, pendingRemove, pendingStart),
  };
  if (pendingRemove !== undefined) {
    item.pendingRemove = pendingRemove;
  }
  if (pendingStart !== undefined) {
    item.pendingStart = pendingStart;
  }
  return item;
}

function createLocalItem(row: DashboardCreateSessionLocalRow): DashboardCreateLocalItem {
  return {
    type: "createLocalRow",
    id: `create:${row.localId}`,
    row,
    presentation: createSessionRowPresentation(row),
  };
}

function sessionRowPresentation(
  row: DashboardSessionRow,
  displayTitle: string,
  pendingRemove: DashboardPendingRemoveWorktreeRowView | undefined,
  pendingStart: DashboardPendingStartAgentRowView | undefined,
): DashboardPersistentFilterVisibleFields {
  if (pendingRemove !== undefined) {
    return { title: displayTitle, activity: "removing session..." };
  }
  if (pendingStart !== undefined) {
    return {
      title: displayTitle,
      activity: pendingStart.operation === "resumeAgent" ? "resuming..." : "starting...",
    };
  }
  const visibleFields = worktreeRowVisibleFields(row.presentation, displayTitle);
  return {
    title: visibleFields.title,
    agent: visibleFields.agent,
    activity: visibleFields.activity,
  };
}

function createSessionRowPresentation(
  row: DashboardCreateSessionLocalRow,
): DashboardPersistentFilterVisibleFields {
  if (row.status === "failed") {
    return { title: row.title, activity: row.error.message };
  }
  return {
    title: row.title,
    agent: row.harnessProvider ?? "",
    activity: "starting session...",
  };
}

function visibleCreateSessionLocalRows(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
): DashboardCreateSessionLocalRow[] {
  const rowsById = new Map(snapshot.rows.map((row) => [row.id, row]));
  const realRows = new Set(
    snapshot.sessions.flatMap((session) => {
      const row = rowsById.get(session.worktreeId);
      return row === undefined ? [] : [`${session.projectId}\u0000${row.branch}`];
    }),
  );
  return [
    ...state.localRows.pendingCreate.flatMap((row) =>
      realRows.has(`${row.projectId}\u0000${row.branch}`)
        ? []
        : [{ ...row, status: "pending" as const }],
    ),
    ...state.localRows.failedCreate.map((row) => ({
      ...row,
      status: "failed" as const,
    })),
  ];
}

function mergeDashboardRows(
  rows: readonly DashboardSessionRow[],
  localRows: readonly DashboardCreateSessionLocalRow[],
  state: DashboardViewState,
): GroupDashboardRow[] {
  return [
    ...rows.map((row) => ({ type: "session" as const, row })),
    ...localRows.map((row) => ({ type: "createLocalRow" as const, row })),
  ].sort((left, right) => compareDashboardRows(left, right, state));
}

function compareDashboardRows(
  left: GroupDashboardRow,
  right: GroupDashboardRow,
  state: DashboardViewState,
): number {
  const titleOrder = rowTitle(left, state).localeCompare(rowTitle(right, state));
  if (titleOrder !== 0) return titleOrder;
  const branchOrder = rowBranch(left).localeCompare(rowBranch(right));
  if (branchOrder !== 0) return branchOrder;
  if (left.type !== right.type) {
    return left.type === "session" ? -1 : 1;
  }
  return rowId(left).localeCompare(rowId(right));
}

function rowTitle(row: GroupDashboardRow, state: DashboardViewState): string {
  if (row.type === "createLocalRow") {
    return row.row.title;
  }
  return sessionRowDisplayTitle(row.row, state.localRows);
}

function rowBranch(row: GroupDashboardRow): string {
  return row.type === "session" ? row.row.worktree.branch : row.row.branch;
}

function rowId(row: GroupDashboardRow): string {
  return row.type === "session" ? row.row.id : row.row.localId;
}

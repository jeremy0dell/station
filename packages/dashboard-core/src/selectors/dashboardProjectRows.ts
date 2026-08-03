import type { ProjectView, StationSnapshot } from "@station/contracts";
import { worktreeRowVisibleFields } from "../components/WorktreeRow/rowInput.js";
import type {
  FailedCreateSessionRow,
  PendingCreateSessionRow,
  PendingRemoveWorktreeRow,
  PendingStartAgentRow,
} from "../state/localRows.js";
import type { TuiViewState } from "../state/types.js";
import type {
  DashboardPersistentFilterCandidate,
  DashboardPersistentFilterProjection,
  DashboardPersistentFilterRowMatch,
  DashboardPersistentFilterVisibleFields,
} from "./dashboardPersistentFilter.js";
import { matchesDashboardOptimisticSearch } from "./dashboardSearchProjection.js";
import {
  type DashboardSessionRow,
  selectProjectGroups,
  sessionRowDisplayTitle,
} from "./dashboardSessionRows.js";

type DashboardCreateSessionLocalRow =
  | ({ status: "pending" } & PendingCreateSessionRow)
  | ({ status: "failed" } & FailedCreateSessionRow);

type DashboardRowPresentation = DashboardPersistentFilterVisibleFields;

export type DashboardSessionItem = {
  type: "session";
  id: string;
  row: DashboardSessionRow;
  displayTitle: string;
  presentation: DashboardRowPresentation;
  pendingRemove?: PendingRemoveWorktreeRow;
  pendingStart?: PendingStartAgentRow;
  persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

export type DashboardCreateLocalItem = {
  type: "createLocalRow";
  id: string;
  row: DashboardCreateSessionLocalRow;
  presentation: DashboardRowPresentation;
  persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

export type DashboardRowItem = DashboardSessionItem | DashboardCreateLocalItem;

export type DashboardProjectRowGroup = {
  project: ProjectView;
  collapsed: boolean;
  rows: DashboardRowItem[];
};

type DashboardProjectRowsOptions = {
  applyLegacySearch: boolean;
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
  snapshot: StationSnapshot,
  state: TuiViewState,
  options: DashboardProjectRowsOptions,
): DashboardProjectRowGroup[] {
  const localRows = visibleCreateSessionLocalRows(snapshot, state);
  return selectProjectGroups(snapshot, state, {
    includeCollapsedRows: true,
    applySearch: options.applyLegacySearch,
  }).map((group) => ({
    project: group.project,
    collapsed: group.collapsed,
    rows: projectRows(group.rows, group.project, localRows, state, options),
  }));
}

export function persistentFilterCandidateForDashboardRow(
  item: DashboardRowItem,
): DashboardPersistentFilterCandidate {
  return {
    kind: item.type === "session" ? "session" : "optimistic",
    id: item.id,
    projectId: item.type === "session" ? item.row.worktree.projectId : item.row.projectId,
    visibleFields: item.presentation,
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
  project: ProjectView,
  localRows: readonly DashboardCreateSessionLocalRow[],
  state: TuiViewState,
  options: DashboardProjectRowsOptions,
): DashboardRowItem[] {
  const projectLocalRows = localRows.filter(
    (row) =>
      row.projectId === project.id &&
      (!options.applyLegacySearch || localRowMatchesSearch(row, project, state)),
  );
  return mergeDashboardRows(sessionRows, projectLocalRows, state).map((row) =>
    row.type === "session" ? sessionItem(row.row, state) : createLocalItem(row.row),
  );
}

function localRowMatchesSearch(
  row: DashboardCreateSessionLocalRow,
  project: ProjectView,
  state: TuiViewState,
): boolean {
  return matchesDashboardOptimisticSearch(
    {
      title: row.title,
      branch: row.branch,
      projectLabel: project.label,
      pendingHarnessProvider: row.status === "pending" ? row.harnessProvider : undefined,
    },
    state.searchQuery,
  );
}

function sessionItem(row: DashboardSessionRow, state: TuiViewState): DashboardSessionItem {
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
  pendingRemove: PendingRemoveWorktreeRow | undefined,
  pendingStart: PendingStartAgentRow | undefined,
): DashboardRowPresentation {
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
): DashboardRowPresentation {
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
  snapshot: StationSnapshot,
  state: TuiViewState,
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
  state: TuiViewState,
): GroupDashboardRow[] {
  return [
    ...rows.map((row) => ({ type: "session" as const, row })),
    ...localRows.map((row) => ({ type: "createLocalRow" as const, row })),
  ].sort((left, right) => compareDashboardRows(left, right, state));
}

function compareDashboardRows(
  left: GroupDashboardRow,
  right: GroupDashboardRow,
  state: TuiViewState,
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

function rowTitle(row: GroupDashboardRow, state: TuiViewState): string {
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

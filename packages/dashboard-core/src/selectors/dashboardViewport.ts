import type { ProjectId, ProjectView, StationSnapshot, WorktreeRow } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import type {
  FailedCreateSessionRow,
  PendingCreateSessionRow,
  PendingRemoveWorktreeRow,
  PendingStartAgentRow,
} from "../state/localRows.js";
import type { TuiViewState } from "../state/types.js";
import {
  type KeyedChoice,
  keyChoices,
  selectProjectGroups,
  worktreeRowDisplayTitle,
} from "./selectors.js";

export type DashboardCreateSessionLocalRow =
  | ({ status: "pending" } & PendingCreateSessionRow)
  | ({ status: "failed" } & FailedCreateSessionRow);

export type DashboardViewportItem =
  | {
      type: "projectGap";
      id: string;
      projectId: ProjectId;
    }
  | {
      type: "projectHeader";
      id: string;
      project: ProjectView;
      collapsed: boolean;
    }
  | {
      type: "emptyProject";
      id: string;
      project: ProjectView;
    }
  | {
      type: "worktree";
      id: string;
      row: WorktreeRow;
      displayTitle: string;
      pendingRemove?: PendingRemoveWorktreeRow;
      pendingStart?: PendingStartAgentRow;
    }
  | {
      type: "createLocalRow";
      id: string;
      row: DashboardCreateSessionLocalRow;
    };

export type DashboardViewport = {
  bodyRows: number;
  clampedScrollOffset: number;
  hiddenAbove: number;
  hiddenBelow: number;
  items: DashboardViewportItem[];
  visibleItems: DashboardViewportItem[];
  rowChoices: Array<KeyedChoice<WorktreeRow>>;
  displayRowChoices: Array<KeyedChoice<WorktreeRow>>;
};

export function selectDashboardViewport(
  snapshot: StationSnapshot,
  state: TuiViewState,
): DashboardViewport {
  const items = selectDashboardItems(snapshot, state);
  const bodyRows = dashboardBodyRows(state.terminalRows);
  const clampedScrollOffset = clampDashboardScrollOffset({
    bodyRows,
    itemCount: items.length,
    scrollOffset: state.scrollOffset,
  });
  const visibleItems = items.slice(clampedScrollOffset, clampedScrollOffset + bodyRows);
  const hiddenAbove = clampedScrollOffset;
  const hiddenBelow = Math.max(0, items.length - clampedScrollOffset - bodyRows);
  const displayRowChoices = keyChoices(displayWorktreeRowsFromItems(visibleItems));
  const pendingStartWorktreeIds = new Set(
    visibleItems.flatMap((item) =>
      item.type === "worktree" && item.pendingStart !== undefined ? [item.row.id] : [],
    ),
  );
  return {
    bodyRows,
    clampedScrollOffset,
    hiddenAbove,
    hiddenBelow,
    items,
    visibleItems,
    rowChoices: displayRowChoices.filter((choice) => !pendingStartWorktreeIds.has(choice.value.id)),
    displayRowChoices,
  };
}

export function selectDashboardItems(
  snapshot: StationSnapshot,
  state: TuiViewState,
): DashboardViewportItem[] {
  const localRows = visibleCreateSessionLocalRows(snapshot, state);
  return selectProjectGroups(snapshot, state).flatMap((group, index) => {
    const items: DashboardViewportItem[] = [];
    if (index > 0) {
      items.push({
        type: "projectGap",
        id: `gap:${group.project.id}`,
        projectId: group.project.id,
      });
    }
    items.push({
      type: "projectHeader",
      id: `project:${group.project.id}`,
      project: group.project,
      collapsed: group.collapsed,
    });
    if (group.collapsed) {
      return items;
    }
    const projectLocalRows = localRows
      .filter((row) => row.projectId === group.project.id)
      .filter((row) => localRowMatchesSearch(row, group.project, state.searchQuery));
    const rows = mergeRowsAndCreateSessionLocalRows(group.rows, projectLocalRows, snapshot, state);
    if (rows.length === 0) {
      items.push({
        type: "emptyProject",
        id: `empty:${group.project.id}`,
        project: group.project,
      });
      return items;
    }
    for (const row of rows) {
      if (row.type === "worktree") {
        const item: Extract<DashboardViewportItem, { type: "worktree" }> = {
          type: "worktree",
          id: `worktree:${row.row.id}`,
          row: row.row,
          displayTitle: worktreeRowDisplayTitle(row.row, snapshot.sessions, state.localRows),
        };
        const pendingRemove = state.localRows.pendingRemove.find(
          (localRow) => localRow.worktreeId === row.row.id,
        );
        if (pendingRemove !== undefined) {
          item.pendingRemove = pendingRemove;
        }
        const pendingStart = state.localRows.pendingStart.find(
          (localRow) => localRow.worktreeId === row.row.id,
        );
        if (pendingStart !== undefined) {
          item.pendingStart = pendingStart;
        }
        items.push(item);
      } else {
        items.push({
          type: "createLocalRow",
          id: `create:${row.row.localId}`,
          row: row.row,
        });
      }
    }
    return items;
  });
}

function displayWorktreeRowsFromItems(items: readonly DashboardViewportItem[]): WorktreeRow[] {
  return items.flatMap((item) =>
    item.type === "worktree" && item.pendingRemove === undefined ? [item.row] : [],
  );
}

type GroupDashboardRow =
  | {
      type: "worktree";
      row: WorktreeRow;
    }
  | {
      type: "createLocalRow";
      row: DashboardCreateSessionLocalRow;
    };

function visibleCreateSessionLocalRows(
  snapshot: StationSnapshot,
  state: TuiViewState,
): DashboardCreateSessionLocalRow[] {
  const realRows = new Set(snapshot.rows.map((row) => `${row.projectId}\u0000${row.branch}`));
  return [
    ...state.localRows.pendingCreate
      .filter((row) => !realRows.has(`${row.projectId}\u0000${row.branch}`))
      .map((row) => ({ ...row, status: "pending" as const })),
    ...state.localRows.failedCreate.map((row) => ({
      ...row,
      status: "failed" as const,
    })),
  ];
}

function mergeRowsAndCreateSessionLocalRows(
  rows: readonly WorktreeRow[],
  localRows: readonly DashboardCreateSessionLocalRow[],
  snapshot: StationSnapshot,
  state: TuiViewState,
): GroupDashboardRow[] {
  return [
    ...rows.map((row) => ({ type: "worktree" as const, row })),
    ...localRows.map((row) => ({ type: "createLocalRow" as const, row })),
  ].sort((left, right) => compareDashboardRows(left, right, snapshot, state));
}

function compareDashboardRows(
  left: GroupDashboardRow,
  right: GroupDashboardRow,
  snapshot: StationSnapshot,
  state: TuiViewState,
): number {
  const titleOrder = rowTitle(left, snapshot, state).localeCompare(
    rowTitle(right, snapshot, state),
  );
  if (titleOrder !== 0) return titleOrder;
  const branchOrder = rowBranch(left).localeCompare(rowBranch(right));
  if (branchOrder !== 0) return branchOrder;
  if (left.type !== right.type) {
    return left.type === "worktree" ? -1 : 1;
  }
  return rowId(left).localeCompare(rowId(right));
}

function rowTitle(row: GroupDashboardRow, snapshot: StationSnapshot, state: TuiViewState): string {
  if (row.type === "createLocalRow") {
    return row.row.branch;
  }
  return worktreeRowDisplayTitle(row.row, snapshot.sessions, state.localRows);
}

function rowBranch(row: GroupDashboardRow): string {
  return row.row.branch;
}

function rowId(row: GroupDashboardRow): string {
  return row.type === "worktree" ? row.row.id : row.row.localId;
}

function localRowMatchesSearch(
  row: DashboardCreateSessionLocalRow,
  project: ProjectView,
  searchQuery: string,
): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }
  const harnessProvider = row.status === "pending" ? (row.harnessProvider ?? "") : "";
  return [row.branch, project.label, harnessProvider].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

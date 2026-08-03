import type { ProjectId } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import { worktreeRowVisibleFields } from "../components/WorktreeRow/rowInput.js";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "../state/types.js";
import {
  type DashboardPersistentFilterCandidate,
  type DashboardPersistentFilterProjection,
  type DashboardPersistentFilterProjectMatch,
  type DashboardPersistentFilterRowMatch,
  type DashboardPersistentFilterVisibleFields,
  selectDashboardPersistentFilter,
} from "./dashboardPersistentFilter.js";
import { matchesDashboardOptimisticSearch } from "./dashboardSearchProjection.js";
import {
  type DashboardSessionRow,
  type KeyedChoice,
  keyChoices,
  selectProjectGroups,
  sessionRowDisplayTitle,
} from "./selectors.js";

type DashboardProjectView = DashboardSnapshotView["projects"][number];
type DashboardPendingCreateSessionRowView =
  DashboardViewState["localRows"]["pendingCreate"][number];
type DashboardFailedCreateSessionRowView = DashboardViewState["localRows"]["failedCreate"][number];
type DashboardPendingRemoveWorktreeRowView =
  DashboardViewState["localRows"]["pendingRemove"][number];
type DashboardPendingStartAgentRowView = DashboardViewState["localRows"]["pendingStart"][number];

export type DashboardCreateSessionLocalRow =
  | ({ readonly status: "pending" } & DashboardPendingCreateSessionRowView)
  | ({ readonly status: "failed" } & DashboardFailedCreateSessionRowView);

export type DashboardRowPresentation = DashboardPersistentFilterVisibleFields;

export type DashboardViewportItem =
  | {
      type: "projectGap";
      id: string;
      projectId: ProjectId;
    }
  | {
      type: "projectHeader";
      id: string;
      project: DashboardProjectView;
      collapsed: boolean;
      persistentFilterMatch?: DashboardPersistentFilterProjectMatch;
    }
  | {
      type: "emptyProject";
      id: string;
      project: DashboardProjectView;
    }
  | {
      type: "session";
      id: string;
      row: DashboardSessionRow;
      displayTitle: string;
      presentation: DashboardRowPresentation;
      pendingRemove?: DashboardPendingRemoveWorktreeRowView;
      pendingStart?: DashboardPendingStartAgentRowView;
      persistentFilterMatch?: DashboardPersistentFilterRowMatch;
    }
  | {
      type: "createLocalRow";
      id: string;
      row: DashboardCreateSessionLocalRow;
      presentation: DashboardRowPresentation;
      persistentFilterMatch?: DashboardPersistentFilterRowMatch;
    };

export type DashboardViewport = {
  bodyRows: number;
  clampedScrollOffset: number;
  hiddenAbove: number;
  hiddenBelow: number;
  items: DashboardViewportItem[];
  visibleItems: DashboardViewportItem[];
  rowChoices: Array<KeyedChoice<DashboardSessionRow>>;
  displayRowChoices: Array<KeyedChoice<DashboardSessionRow>>;
  sessionOverflow: DashboardSessionOverflow;
  persistentFilter?: DashboardPersistentFilterProjection;
};

/** Session-row counts (not raw item counts) for the scroll-overflow labels. */
export type DashboardSessionOverflow = {
  above: number;
  below: number;
  visible: number;
  total: number;
};

export function selectDashboardViewport(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen: DashboardScreenView = { name: "dashboard" },
): DashboardViewport {
  const { items, persistentFilter } = selectDashboardItemsProjection(snapshot, state, activeScreen);
  const bodyRows = dashboardBodyRows(state.terminalRows);
  const clampedScrollOffset = clampDashboardScrollOffset({
    bodyRows,
    itemCount: items.length,
    scrollOffset: state.scrollOffset,
  });
  const visibleItems = items.slice(clampedScrollOffset, clampedScrollOffset + bodyRows);
  const hiddenAbove = clampedScrollOffset;
  const hiddenBelow = Math.max(0, items.length - clampedScrollOffset - bodyRows);
  const displayRowChoices = keyChoices(displaySessionRowsFromItems(visibleItems));
  const pendingStartWorktreeIds = new Set(
    visibleItems.flatMap((item) =>
      item.type === "session" && item.pendingStart !== undefined ? [item.row.worktree.id] : [],
    ),
  );
  const above = countSessionRows(items.slice(0, clampedScrollOffset));
  const visible = countSessionRows(visibleItems);
  const total = countSessionRows(items);
  const viewport: DashboardViewport = {
    bodyRows,
    clampedScrollOffset,
    hiddenAbove,
    hiddenBelow,
    items,
    visibleItems,
    rowChoices: displayRowChoices.filter(
      (choice) => !pendingStartWorktreeIds.has(choice.value.worktree.id),
    ),
    displayRowChoices,
    sessionOverflow: { above, below: total - above - visible, visible, total },
  };
  if (persistentFilter !== undefined) {
    viewport.persistentFilter = persistentFilter;
  }
  return viewport;
}

function countSessionRows(items: readonly DashboardViewportItem[]): number {
  return items.filter((item) => item.type === "session" || item.type === "createLocalRow").length;
}

export function selectDashboardItems(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen: DashboardScreenView = { name: "dashboard" },
): DashboardViewportItem[] {
  return selectDashboardItemsProjection(snapshot, state, activeScreen).items;
}

function selectDashboardItemsProjection(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen: DashboardScreenView,
): {
  items: DashboardViewportItem[];
  persistentFilter: DashboardPersistentFilterProjection | undefined;
} {
  const items = selectDashboardItemsWithoutPersistentFilter(snapshot, state);
  const projects = items.flatMap((item) =>
    item.type === "projectHeader"
      ? [{ projectId: item.project.id, projectLabel: item.project.label }]
      : [],
  );
  const candidates = items.flatMap((item) => {
    const candidate = persistentFilterCandidate(item);
    return candidate === undefined ? [] : [candidate];
  });
  const persistentFilter = selectDashboardPersistentFilter({
    candidates,
    projects,
    screen: activeScreen,
    ...(state.persistentFilter === undefined ? {} : { applied: state.persistentFilter }),
  });
  if (persistentFilter === undefined) {
    return { items, persistentFilter };
  }
  return {
    items: items.map((item) => attachPersistentFilterMatch(item, persistentFilter)),
    persistentFilter,
  };
}

function persistentFilterCandidate(
  item: DashboardViewportItem,
): DashboardPersistentFilterCandidate | undefined {
  if (item.type === "session") {
    return {
      kind: "session",
      id: item.id,
      projectId: item.row.worktree.projectId,
      visibleFields: item.presentation,
    };
  }
  if (item.type === "createLocalRow") {
    return {
      kind: "optimistic",
      id: item.id,
      projectId: item.row.projectId,
      visibleFields: item.presentation,
    };
  }
  return undefined;
}

function attachPersistentFilterMatch(
  item: DashboardViewportItem,
  projection: DashboardPersistentFilterProjection,
): DashboardViewportItem {
  if (item.type === "projectHeader") {
    const match = projection.projects.get(item.project.id);
    return match === undefined ? item : { ...item, persistentFilterMatch: match };
  }
  if (item.type === "session" || item.type === "createLocalRow") {
    const match = projection.rows.get(item.id);
    return match === undefined ? item : { ...item, persistentFilterMatch: match };
  }
  return item;
}

function selectDashboardItemsWithoutPersistentFilter(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
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
      .filter((row) =>
        matchesDashboardOptimisticSearch(
          {
            title: row.title,
            branch: row.branch,
            projectLabel: group.project.label,
            pendingHarnessProvider: row.status === "pending" ? row.harnessProvider : undefined,
          },
          state.searchQuery,
        ),
      );
    const rows = mergeRowsAndCreateSessionLocalRows(group.rows, projectLocalRows, state);
    if (rows.length === 0) {
      items.push({
        type: "emptyProject",
        id: `empty:${group.project.id}`,
        project: group.project,
      });
      return items;
    }
    for (const row of rows) {
      if (row.type === "session") {
        const displayTitle = sessionRowDisplayTitle(row.row, state.localRows);
        const pendingRemove = state.localRows.pendingRemove.find(
          (localRow) => localRow.worktreeId === row.row.worktree.id,
        );
        const pendingStart = state.localRows.pendingStart.find(
          (localRow) => localRow.worktreeId === row.row.worktree.id,
        );
        const item: Extract<DashboardViewportItem, { type: "session" }> = {
          type: "session",
          id: `session:${row.row.id}`,
          row: row.row,
          displayTitle,
          presentation: sessionRowPresentation(row.row, displayTitle, pendingRemove, pendingStart),
        };
        if (pendingRemove !== undefined) {
          item.pendingRemove = pendingRemove;
        }
        if (pendingStart !== undefined) {
          item.pendingStart = pendingStart;
        }
        items.push(item);
      } else {
        items.push({
          type: "createLocalRow",
          id: `create:${row.row.localId}`,
          row: row.row,
          presentation: createSessionRowPresentation(row.row),
        });
      }
    }
    return items;
  });
}

function sessionRowPresentation(
  row: DashboardSessionRow,
  displayTitle: string,
  pendingRemove: DashboardPendingRemoveWorktreeRowView | undefined,
  pendingStart: DashboardPendingStartAgentRowView | undefined,
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

function displaySessionRowsFromItems(
  items: readonly DashboardViewportItem[],
): DashboardSessionRow[] {
  return items.flatMap((item) =>
    item.type === "session" && item.pendingRemove === undefined ? [item.row] : [],
  );
}

type GroupDashboardRow =
  | {
      type: "session";
      row: DashboardSessionRow;
    }
  | {
      type: "createLocalRow";
      row: DashboardCreateSessionLocalRow;
    };

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

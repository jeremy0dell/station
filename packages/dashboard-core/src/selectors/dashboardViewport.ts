import type { ProjectId, ProjectView, StationSnapshot } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import { worktreeRowVisibleFields } from "../components/WorktreeRow/rowInput.js";
import type {
  FailedCreateSessionRow,
  PendingCreateSessionRow,
  PendingRemoveWorktreeRow,
  PendingStartAgentRow,
} from "../state/localRows.js";
import type { TuiScreen, TuiViewState } from "../state/types.js";
import {
  type DashboardPersistentFilterCandidate,
  type DashboardPersistentFilterHiddenFields,
  type DashboardPersistentFilterMatchReason,
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

export type DashboardCreateSessionLocalRow =
  | ({ status: "pending" } & PendingCreateSessionRow)
  | ({ status: "failed" } & FailedCreateSessionRow);

export type DashboardRowPresentation = DashboardPersistentFilterVisibleFields;

type DashboardSessionViewportItem = {
  type: "session";
  id: string;
  row: DashboardSessionRow;
  displayTitle: string;
  presentation: DashboardRowPresentation;
  pendingRemove?: PendingRemoveWorktreeRow;
  pendingStart?: PendingStartAgentRow;
  persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

type DashboardCreateLocalViewportItem = {
  type: "createLocalRow";
  id: string;
  row: DashboardCreateSessionLocalRow;
  presentation: DashboardRowPresentation;
  persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

type DashboardRowViewportItem = DashboardSessionViewportItem | DashboardCreateLocalViewportItem;

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
      /** Stored disclosure state; applied matches may render children without changing it. */
      collapsed: boolean;
      persistentFilterMatch?: DashboardPersistentFilterProjectMatch;
    }
  | {
      type: "emptyProject";
      id: string;
      project: ProjectView;
    }
  | DashboardSessionViewportItem
  | DashboardCreateLocalViewportItem
  | {
      type: "matchReason";
      id: string;
      rowId: string;
      reason: DashboardPersistentFilterMatchReason;
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

type DashboardViewportState = TuiViewState & { screen?: TuiScreen };

export function selectDashboardViewport(
  snapshot: StationSnapshot,
  state: DashboardViewportState,
  activeScreen?: TuiScreen,
): DashboardViewport {
  const selectedScreen = activeScreen ?? state.screen ?? { name: "dashboard" };
  const { items, persistentFilter } = selectDashboardItemsProjection(
    snapshot,
    state,
    selectedScreen,
  );
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
  snapshot: StationSnapshot,
  state: DashboardViewportState,
  activeScreen?: TuiScreen,
): DashboardViewportItem[] {
  return selectDashboardItemsProjection(
    snapshot,
    state,
    activeScreen ?? state.screen ?? { name: "dashboard" },
  ).items;
}

type DashboardItemGroup = {
  project: ProjectView;
  collapsed: boolean;
  children: DashboardRowViewportItem[];
};

function selectDashboardItemsProjection(
  snapshot: StationSnapshot,
  state: TuiViewState,
  activeScreen: TuiScreen,
): {
  items: DashboardViewportItem[];
  persistentFilter: DashboardPersistentFilterProjection | undefined;
} {
  const persistentFilterSelected =
    activeScreen.name === "persistentFilter" || state.persistentFilter !== undefined;
  const groups = selectDashboardItemGroups(snapshot, state, {
    applyLegacySearch: !persistentFilterSelected,
  });
  const persistentFilter = selectDashboardPersistentFilter({
    candidates: groups.flatMap((group) => group.children.map(persistentFilterCandidate)),
    projects: groups.map((group) => ({
      projectId: group.project.id,
      projectLabel: group.project.label,
    })),
    screen: activeScreen,
    ...(state.persistentFilter === undefined ? {} : { applied: state.persistentFilter }),
  });

  if (persistentFilter === undefined) {
    return { items: flattenDashboardGroups(groups), persistentFilter };
  }
  if (persistentFilter.source === "draft" || persistentFilter.query.length === 0) {
    return {
      items: flattenDashboardGroups(groups, persistentFilter),
      persistentFilter,
    };
  }
  return {
    items: flattenAppliedDashboardGroups(groups, persistentFilter),
    persistentFilter,
  };
}

function selectDashboardItemGroups(
  snapshot: StationSnapshot,
  state: TuiViewState,
  options: { applyLegacySearch: boolean },
): DashboardItemGroup[] {
  const localRows = visibleCreateSessionLocalRows(snapshot, state);
  return selectProjectGroups(snapshot, state, {
    includeCollapsedRows: true,
    applySearch: options.applyLegacySearch,
  }).map((group) => {
    const projectLocalRows = localRows
      .filter((row) => row.projectId === group.project.id)
      .filter(
        (row) =>
          !options.applyLegacySearch ||
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
    return {
      project: group.project,
      collapsed: group.collapsed,
      children: mergeRowsAndCreateSessionLocalRows(group.rows, projectLocalRows, state).map(
        (row) =>
          row.type === "session"
            ? sessionViewportItem(row.row, state)
            : createLocalViewportItem(row.row),
      ),
    };
  });
}

function flattenDashboardGroups(
  groups: readonly DashboardItemGroup[],
  projection?: DashboardPersistentFilterProjection,
): DashboardViewportItem[] {
  return groups.flatMap((group, index) => {
    const items: DashboardViewportItem[] = [];
    if (index > 0) {
      items.push({
        type: "projectGap",
        id: `gap:${group.project.id}`,
        projectId: group.project.id,
      });
    }
    items.push(projectHeaderItem(group, projection));
    if (group.collapsed) {
      return items;
    }
    if (group.children.length === 0) {
      items.push(emptyProjectItem(group.project));
      return items;
    }
    items.push(
      ...group.children.map((child) =>
        projection === undefined ? child : attachPersistentFilterRowMatch(child, projection),
      ),
    );
    return items;
  });
}

function flattenAppliedDashboardGroups(
  groups: readonly DashboardItemGroup[],
  projection: DashboardPersistentFilterProjection,
): DashboardViewportItem[] {
  const retained = groups.filter((group) => projection.projects.get(group.project.id)?.matched);
  return retained.flatMap((group, index) => {
    const items: DashboardViewportItem[] = [];
    if (index > 0) {
      items.push({
        type: "projectGap",
        id: `gap:${group.project.id}`,
        projectId: group.project.id,
      });
    }
    items.push(projectHeaderItem(group, projection));
    const matchingChildren = group.children.filter(
      (child) => projection.rows.get(child.id)?.matched === true,
    );
    if (matchingChildren.length === 0) {
      if (group.children.length === 0) {
        items.push(emptyProjectItem(group.project));
      }
      return items;
    }
    for (const child of matchingChildren) {
      const matchedChild = attachPersistentFilterRowMatch(child, projection);
      items.push(matchedChild);
      const reason = matchedChild.persistentFilterMatch?.reason;
      if (reason !== undefined) {
        items.push({
          type: "matchReason",
          id: `reason:${child.id}`,
          rowId: child.id,
          reason,
        });
      }
    }
    return items;
  });
}

function projectHeaderItem(
  group: DashboardItemGroup,
  projection?: DashboardPersistentFilterProjection,
): Extract<DashboardViewportItem, { type: "projectHeader" }> {
  const item: Extract<DashboardViewportItem, { type: "projectHeader" }> = {
    type: "projectHeader",
    id: `project:${group.project.id}`,
    project: group.project,
    collapsed: group.collapsed,
  };
  const match = projection?.projects.get(group.project.id);
  if (match !== undefined) {
    item.persistentFilterMatch = match;
  }
  return item;
}

function emptyProjectItem(
  project: ProjectView,
): Extract<DashboardViewportItem, { type: "emptyProject" }> {
  return {
    type: "emptyProject",
    id: `empty:${project.id}`,
    project,
  };
}

function sessionViewportItem(
  row: DashboardSessionRow,
  state: TuiViewState,
): DashboardSessionViewportItem {
  const displayTitle = sessionRowDisplayTitle(row, state.localRows);
  const pendingRemove = state.localRows.pendingRemove.find(
    (localRow) => localRow.worktreeId === row.worktree.id,
  );
  const pendingStart = state.localRows.pendingStart.find(
    (localRow) => localRow.worktreeId === row.worktree.id,
  );
  const item: DashboardSessionViewportItem = {
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

function createLocalViewportItem(
  row: DashboardCreateSessionLocalRow,
): DashboardCreateLocalViewportItem {
  return {
    type: "createLocalRow",
    id: `create:${row.localId}`,
    row,
    presentation: createSessionRowPresentation(row),
  };
}

function persistentFilterCandidate(
  item: DashboardRowViewportItem,
): DashboardPersistentFilterCandidate {
  const candidate: DashboardPersistentFilterCandidate = {
    kind: item.type === "session" ? "session" : "optimistic",
    id: item.id,
    projectId: item.type === "session" ? item.row.worktree.projectId : item.row.projectId,
    visibleFields: item.presentation,
  };
  const hiddenFields = persistentFilterHiddenFields(item);
  if (hiddenFields !== undefined) {
    candidate.hiddenFields = hiddenFields;
  }
  return candidate;
}

function persistentFilterHiddenFields(
  item: DashboardRowViewportItem,
): DashboardPersistentFilterHiddenFields | undefined {
  const fields: DashboardPersistentFilterHiddenFields = {};
  const branch = item.type === "session" ? item.row.worktree.branch : item.row.branch;
  if (branch !== item.presentation.title) {
    fields.branch = branch;
  }
  if (item.type === "session") {
    fields.status = item.row.session.status.value;
    if (item.row.session.status.reason !== undefined) {
      fields.reason = item.row.session.status.reason;
    }
    if (item.row.session.terminal?.provider !== undefined) {
      fields.terminal = item.row.session.terminal.provider;
    }
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
}

function attachPersistentFilterRowMatch(
  item: DashboardRowViewportItem,
  projection: DashboardPersistentFilterProjection,
): DashboardRowViewportItem {
  const match = projection.rows.get(item.id);
  return match === undefined ? item : { ...item, persistentFilterMatch: match };
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

function mergeRowsAndCreateSessionLocalRows(
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

import type { ProjectId } from "@station/contracts";
import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "../state/types.js";
import {
  type DashboardPersistentFilterProjection,
  type DashboardPersistentFilterProjectMatch,
  selectDashboardPersistentFilter,
} from "./dashboardPersistentFilter.js";
import {
  type DashboardCreateLocalItem,
  type DashboardProjectRowGroup,
  type DashboardRowItem,
  type DashboardSessionItem,
  persistentFilterCandidateForDashboardRow,
  selectDashboardProjectRowGroups,
  withDashboardRowFilterMatch,
} from "./dashboardProjectRows.js";
import type { DashboardSessionRow } from "./dashboardSessionRows.js";
import { type KeyedChoice, keyChoices } from "./selectors.js";

type DashboardProjectView = DashboardSnapshotView["projects"][number];

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
      /** Stored disclosure state; applied matches may render children without changing it. */
      collapsed: boolean;
      persistentFilterMatch?: DashboardPersistentFilterProjectMatch;
    }
  | {
      type: "emptyProject";
      id: string;
      project: DashboardProjectView;
    }
  | DashboardSessionItem
  | DashboardCreateLocalItem;

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

type DashboardViewportState = DashboardViewState & { readonly screen?: DashboardScreenView };

export function selectDashboardViewport(
  snapshot: DashboardSnapshotView,
  state: DashboardViewportState,
  activeScreen?: DashboardScreenView,
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

export function selectDashboardItems(
  snapshot: DashboardSnapshotView,
  state: DashboardViewportState,
  activeScreen?: DashboardScreenView,
): DashboardViewportItem[] {
  return selectDashboardItemsProjection(
    snapshot,
    state,
    activeScreen ?? state.screen ?? { name: "dashboard" },
  ).items;
}

function selectDashboardItemsProjection(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen: DashboardScreenView,
): {
  items: DashboardViewportItem[];
  persistentFilter: DashboardPersistentFilterProjection | undefined;
} {
  const persistentFilterSelected =
    activeScreen.name === "persistentFilter" || state.persistentFilter !== undefined;
  const groups = selectDashboardProjectRowGroups(snapshot, state, {
    applyLegacySearch: !persistentFilterSelected,
  });
  const persistentFilter = selectDashboardPersistentFilter({
    candidates: groups.flatMap((group) => group.rows.map(persistentFilterCandidateForDashboardRow)),
    projects: groups.map((group) => ({
      projectId: group.project.id,
      projectLabel: group.project.label,
    })),
    screen: activeScreen,
    ...(state.persistentFilter === undefined ? {} : { applied: state.persistentFilter }),
  });
  return {
    items: flattenDashboardGroups(groups, persistentFilter),
    persistentFilter,
  };
}

function flattenDashboardGroups(
  groups: readonly DashboardProjectRowGroup[],
  projection?: DashboardPersistentFilterProjection,
): DashboardViewportItem[] {
  const applied = projection?.source === "applied" && projection.query.length > 0;
  const visibleGroups = applied
    ? groups.filter((group) => projection.projects.get(group.project.id)?.matched)
    : groups;
  return visibleGroups.flatMap((group, index) => [
    ...(index === 0 ? [] : [projectGapItem(group.project.id)]),
    ...projectGroupItems(group, projection, applied),
  ]);
}

function projectGroupItems(
  group: DashboardProjectRowGroup,
  projection: DashboardPersistentFilterProjection | undefined,
  applied: boolean,
): DashboardViewportItem[] {
  const items: DashboardViewportItem[] = [projectHeaderItem(group, projection)];
  const rows = visibleProjectRows(group, projection, applied);
  if (rows.length > 0) {
    items.push(
      ...rows.map((row) =>
        projection === undefined ? row : withDashboardRowFilterMatch(row, projection),
      ),
    );
  } else if (group.rows.length === 0 && (!group.collapsed || applied)) {
    items.push(emptyProjectItem(group.project));
  }
  return items;
}

function visibleProjectRows(
  group: DashboardProjectRowGroup,
  projection: DashboardPersistentFilterProjection | undefined,
  applied: boolean,
): readonly DashboardRowItem[] {
  if (applied && projection !== undefined) {
    return group.rows.filter((row) => projection.rows.get(row.id)?.matched === true);
  }
  return group.collapsed ? [] : group.rows;
}

function projectGapItem(
  projectId: ProjectId,
): Extract<DashboardViewportItem, { type: "projectGap" }> {
  return {
    type: "projectGap",
    id: `gap:${projectId}`,
    projectId,
  };
}

function projectHeaderItem(
  group: DashboardProjectRowGroup,
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
  project: DashboardProjectView,
): Extract<DashboardViewportItem, { type: "emptyProject" }> {
  return {
    type: "emptyProject",
    id: `empty:${project.id}`,
    project,
  };
}

function displaySessionRowsFromItems(
  items: readonly DashboardViewportItem[],
): DashboardSessionRow[] {
  return items.flatMap((item) =>
    item.type === "session" && item.pendingRemove === undefined ? [item.row] : [],
  );
}

function countSessionRows(items: readonly DashboardViewportItem[]): number {
  return items.filter((item) => item.type === "session" || item.type === "createLocalRow").length;
}

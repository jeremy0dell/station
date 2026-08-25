import type { ProjectId, SessionGroupId, SessionId } from "@station/contracts";
import { worktreeRowVisibleFields } from "../components/WorktreeRow/rowInput.js";
import type {
  DashboardGroupHeaderActionVisibility,
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "../state/types.js";
import {
  projectTreeGrid,
  type TreeGridCursor,
  type TreeGridNode,
  type TreeGridProjection,
  type TreeGridRow,
} from "../treeGrid.js";
import {
  type DashboardPersistentFilterCandidate,
  type DashboardPersistentFilterGroupMatch,
  type DashboardPersistentFilterProjection,
  type DashboardPersistentFilterProjectMatch,
  type DashboardPersistentFilterRowMatch,
  type DashboardPersistentFilterVisibleFields,
  selectDashboardPersistentFilter,
} from "./dashboardPersistentFilter.js";
import {
  type DashboardSessionRow,
  selectDashboardSessionRows,
  sessionRowDisplayTitle,
} from "./dashboardSessionRows.js";

declare const dashboardRowIdBrand: unique symbol;

/** Namespaced dashboard row identity constructed only by {@link dashboardRowIds}. */
export type DashboardRowId = string & {
  readonly [dashboardRowIdBrand]: true;
};

/** Sole constructors for dashboard row IDs; consumers resolve IDs instead of parsing them. */
export const dashboardRowIds = {
  project: (projectId: ProjectId): DashboardRowId => `project:${projectId}` as DashboardRowId,
  group: (groupId: SessionGroupId): DashboardRowId => `group:${groupId}` as DashboardRowId,
  groupFrameEnd: (groupId: SessionGroupId): DashboardRowId =>
    `group-frame-end:${groupId}` as DashboardRowId,
  session: (sessionId: SessionId): DashboardRowId => `session:${sessionId}` as DashboardRowId,
  create: (localId: string): DashboardRowId => `create:${localId}` as DashboardRowId,
  empty: (projectId: ProjectId): DashboardRowId => `empty:${projectId}` as DashboardRowId,
  gap: (projectId: ProjectId): DashboardRowId => `gap:${projectId}` as DashboardRowId,
} as const;

export type DashboardCellId = "identity" | "shell" | "quickSession" | "addSession" | "menu";

/** Determines whether Group blocks precede or interleave with project-root session rows. */
export type GroupOrderingMode = "groups-first" | "alphabetical-interleaved";

export type DashboardFocus = TreeGridCursor<DashboardRowId, DashboardCellId>;

type DashboardProjectView = DashboardSnapshotView["projects"][number];
type DashboardGroupView = DashboardSnapshotView["sessionGroups"][number];
type DashboardPendingCreateSessionRowView =
  DashboardViewState["localRows"]["pendingCreate"][number];
type DashboardFailedCreateSessionRowView = DashboardViewState["localRows"]["failedCreate"][number];
type DashboardPendingRemoveWorktreeRowView =
  DashboardViewState["localRows"]["pendingRemove"][number];
type DashboardPendingStartAgentRowView = DashboardViewState["localRows"]["pendingStart"][number];

export type DashboardCreateSessionLocalRow =
  | ({ readonly status: "pending" } & DashboardPendingCreateSessionRowView)
  | ({ readonly status: "failed" } & DashboardFailedCreateSessionRowView);

export type DashboardProjectHeaderPayload = {
  readonly type: "projectHeader";
  readonly project: DashboardProjectView;
  readonly collapsed: boolean;
  readonly groupCount: number;
  readonly persistentFilterMatch?: DashboardPersistentFilterProjectMatch;
};

/**
 * Canonical snapshots enforce exclusive direct membership; the dashboard flattens parent links,
 * and the viewport assigns global logical shortcuts to projected sessions.
 */
export type DashboardGroupHeaderPayload = {
  readonly type: "groupHeader";
  readonly group: DashboardGroupView;
  readonly collapsed: boolean;
  readonly sessionCount: number;
  readonly visibleSessionCount: number;
  readonly persistentFilterMatch?: DashboardPersistentFilterGroupMatch;
};

/** Inert closing-frame row that consumes viewport height without focus cells or selection slots. */
export type DashboardGroupFrameEndPayload = {
  readonly type: "groupFrameEnd";
  readonly groupId: SessionGroupId;
};

export type DashboardSessionPayload = {
  readonly type: "session";
  readonly row: DashboardSessionRow;
  readonly displayTitle: string;
  readonly presentation: DashboardPersistentFilterVisibleFields;
  readonly pendingRemove?: DashboardPendingRemoveWorktreeRowView;
  readonly pendingStart?: DashboardPendingStartAgentRowView;
  readonly persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

export type DashboardCreateLocalRowPayload = {
  readonly type: "createLocalRow";
  readonly row: DashboardCreateSessionLocalRow;
  readonly presentation: DashboardPersistentFilterVisibleFields;
  readonly persistentFilterMatch?: DashboardPersistentFilterRowMatch;
};

export type DashboardEmptyProjectPayload = {
  readonly type: "emptyProject";
  readonly project: DashboardProjectView;
};

export type DashboardProjectGapPayload = {
  readonly type: "projectGap";
  readonly projectId: ProjectId;
};

export type DashboardTreePayload =
  | DashboardProjectHeaderPayload
  | DashboardGroupHeaderPayload
  | DashboardGroupFrameEndPayload
  | DashboardSessionPayload
  | DashboardCreateLocalRowPayload
  | DashboardEmptyProjectPayload
  | DashboardProjectGapPayload;

export type DashboardTreeRow = TreeGridRow<
  DashboardRowId,
  DashboardCellId,
  DashboardTreePayload
> & {
  /** Focus and containment decoration rebuild rows; row identity is not cursor-independent. */
  readonly focusedCellId?: DashboardCellId;
  /** Present when this Group contains the directly focused visible row. */
  readonly containsFocusedRow?: true;
};

export type DashboardTreeProjection = Omit<
  TreeGridProjection<DashboardRowId, DashboardCellId, DashboardTreePayload>,
  "rowById" | "visibleRows"
> & {
  readonly rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>;
  readonly visibleRows: readonly DashboardTreeRow[];
  readonly persistentFilter?: DashboardPersistentFilterProjection;
};

type DashboardTreeNode = TreeGridNode<DashboardRowId, DashboardCellId, DashboardTreePayload>;

type MergedDashboardRow =
  | { readonly type: "session"; readonly row: DashboardSessionRow }
  | { readonly type: "createLocalRow"; readonly row: DashboardCreateSessionLocalRow };

type ProjectRows = {
  readonly project: DashboardProjectView;
  readonly collapsed: boolean;
  readonly rows: readonly (DashboardSessionPayload | DashboardCreateLocalRowPayload)[];
  readonly rootRows: readonly (DashboardSessionPayload | DashboardCreateLocalRowPayload)[];
  readonly groups: readonly ProjectGroupRows[];
};

type ProjectGroupRows = {
  readonly group: DashboardGroupView;
  readonly collapsed: boolean;
  readonly rows: readonly (DashboardSessionPayload | DashboardCreateLocalRowPayload)[];
};

const PROJECT_CELLS = ["identity", "shell", "quickSession", "menu"] as const;
const SESSION_CELLS = ["identity"] as const;
const EMPTY_PROJECT_CELLS = ["addSession"] as const;

/**
 * Projects canonical hierarchy while targeted pending rows may bridge one ungrouped session into
 * its intended Group; `snapshot.sessionGroups` remains the sole membership authority.
 */
export function selectDashboardTree(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen: DashboardScreenView,
): DashboardTreeProjection {
  // Normalize membership once so filtering and tree construction cannot diverge.
  const projects = projectRowsForSnapshot(snapshot, state);
  // Filtering annotates and admits rows from that model; it never creates a parallel hierarchy.
  const persistentFilter = selectTreePersistentFilter(
    projects,
    snapshot.sessionGroups,
    activeScreen,
    state.persistentFilter,
  );
  const projection = projectTreeGrid(
    dashboardRoots(
      projects,
      persistentFilter,
      state.groupOrderingMode,
      state.groupHeaderActionVisibility,
    ),
  );
  // Focus decorates the finished projection and never becomes structural authority.
  return decorateDashboardProjection(projection, state.dashboardFocus, persistentFilter);
}

function projectRowsForSnapshot(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
): ProjectRows[] {
  const sessionRows = selectDashboardSessionRows(snapshot);
  const localRows = visibleCreateSessionLocalRows(snapshot, state);
  const suppressedSessionIds = targetedPendingCanonicalSessionIds(snapshot, localRows);
  const groupBySessionId = new Map<SessionId, DashboardGroupView>();
  for (const group of snapshot.sessionGroups) {
    for (const sessionId of group.sessionIds) {
      groupBySessionId.set(sessionId, group);
    }
  }
  const projects = snapshot.projects.map((project): ProjectRows => {
    const rows = mergeDashboardRows(
      sessionRows.filter(
        (row) => row.worktree.projectId === project.id && !suppressedSessionIds.has(row.id),
      ),
      localRows.filter((row) => row.projectId === project.id),
      state,
    ).map((row) =>
      row.type === "session" ? sessionPayload(row.row, state) : createLocalPayload(row.row),
    );
    const groups = snapshot.sessionGroups
      .filter((group) => group.projectId === project.id)
      .map((group) => ({
        group,
        collapsed: state.collapsedGroupIds.has(group.id),
        rows: rows.filter((row) =>
          row.type === "session"
            ? groupBySessionId.get(row.row.id)?.id === group.id
            : row.row.status === "pending" && row.row.targetGroupId === group.id,
        ),
      }));
    return {
      project,
      collapsed: state.collapsedProjectIds.has(project.id),
      rows,
      rootRows: rows.filter((row) =>
        row.type === "createLocalRow"
          ? row.row.status === "failed" || row.row.targetGroupId === undefined
          : groupBySessionId.get(row.row.id) === undefined,
      ),
      groups,
    };
  });
  return projects;
}

function visibleCreateSessionLocalRows(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
): DashboardCreateSessionLocalRow[] {
  const rowsById = new Map(snapshot.rows.map((row) => [row.id, row]));
  const canonicalProjectBranches = new Set(
    snapshot.sessions.flatMap((session) => {
      const row = rowsById.get(session.worktreeId);
      return row === undefined ? [] : [`${session.projectId}\u0000${row.branch}`];
    }),
  );
  return [
    ...state.localRows.pendingCreate
      .filter(
        (row) =>
          row.targetGroupId !== undefined ||
          !canonicalProjectBranches.has(`${row.projectId}\u0000${row.branch}`),
      )
      .map((row) => ({ ...row, status: "pending" as const })),
    ...state.localRows.failedCreate.map((row) => ({ ...row, status: "failed" as const })),
  ];
}

function targetedPendingCanonicalSessionIds(
  snapshot: DashboardSnapshotView,
  localRows: readonly DashboardCreateSessionLocalRow[],
): ReadonlySet<SessionId> {
  const targetedBranches = new Set(
    localRows.flatMap((row) =>
      row.status === "pending" && row.targetGroupId !== undefined
        ? [`${row.projectId}\u0000${row.branch}`]
        : [],
    ),
  );
  const groupedSessionIds = new Set(snapshot.sessionGroups.flatMap((group) => group.sessionIds));
  const rowsById = new Map(snapshot.rows.map((row) => [row.id, row]));
  return new Set(
    snapshot.sessions.flatMap((session) => {
      const row = rowsById.get(session.worktreeId);
      return row !== undefined &&
        !groupedSessionIds.has(session.id) &&
        targetedBranches.has(`${session.projectId}\u0000${row.branch}`)
        ? [session.id]
        : [];
    }),
  );
}

function mergeDashboardRows(
  rows: readonly DashboardSessionRow[],
  localRows: readonly DashboardCreateSessionLocalRow[],
  state: DashboardViewState,
): MergedDashboardRow[] {
  return [
    ...rows.map((row) => ({ type: "session" as const, row })),
    ...localRows.map((row) => ({ type: "createLocalRow" as const, row })),
  ].sort((left, right) => compareDashboardRows(left, right, state));
}

function compareDashboardRows(
  left: MergedDashboardRow,
  right: MergedDashboardRow,
  state: DashboardViewState,
): number {
  return (
    rowTitle(left, state).localeCompare(rowTitle(right, state)) ||
    rowBranch(left).localeCompare(rowBranch(right)) ||
    (left.type === right.type
      ? rowStableId(left).localeCompare(rowStableId(right))
      : left.type === "session"
        ? -1
        : 1)
  );
}

function rowTitle(row: MergedDashboardRow, state: DashboardViewState): string {
  return row.type === "session" ? sessionRowDisplayTitle(row.row, state.localRows) : row.row.title;
}

function rowBranch(row: MergedDashboardRow): string {
  return row.type === "session" ? row.row.worktree.branch : row.row.branch;
}

function rowStableId(row: MergedDashboardRow): string {
  return row.type === "session" ? row.row.id : row.row.localId;
}

function sessionPayload(
  row: DashboardSessionRow,
  state: DashboardViewState,
): DashboardSessionPayload {
  const displayTitle = sessionRowDisplayTitle(row, state.localRows);
  const pendingRemove = state.localRows.pendingRemove.find(
    (localRow) => localRow.worktreeId === row.worktree.id,
  );
  const pendingStart = state.localRows.pendingStart.find(
    (localRow) => localRow.worktreeId === row.worktree.id,
  );
  return {
    type: "session",
    row,
    displayTitle,
    presentation: sessionRowPresentation(row, displayTitle, pendingRemove, pendingStart),
    ...(pendingRemove === undefined ? {} : { pendingRemove }),
    ...(pendingStart === undefined ? {} : { pendingStart }),
  };
}

function createLocalPayload(row: DashboardCreateSessionLocalRow): DashboardCreateLocalRowPayload {
  return {
    type: "createLocalRow",
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

function rowIdForPayload(
  payload: DashboardSessionPayload | DashboardCreateLocalRowPayload,
): DashboardRowId {
  return payload.type === "session"
    ? dashboardRowIds.session(payload.row.id)
    : dashboardRowIds.create(payload.row.localId);
}

function selectTreePersistentFilter(
  projects: readonly ProjectRows[],
  groups: readonly DashboardGroupView[],
  screen: DashboardScreenView,
  applied: DashboardViewState["persistentFilter"],
): DashboardPersistentFilterProjection | undefined {
  return selectDashboardPersistentFilter({
    candidates: projects.flatMap((project) => [
      ...project.rootRows.map((row) => persistentFilterCandidate(rowIdForPayload(row), row)),
      ...project.groups.flatMap(({ group, rows }) =>
        rows.map((row) => persistentFilterCandidate(rowIdForPayload(row), row, group.id)),
      ),
    ]),
    projects: projects.map(({ project }) => ({
      projectId: project.id,
      projectLabel: project.label,
    })),
    groups: groups.map((group) => ({
      groupId: group.id,
      projectId: group.projectId,
      groupLabel: group.name,
    })),
    screen,
    ...(applied === undefined ? {} : { applied }),
  });
}

function persistentFilterCandidate(
  id: DashboardRowId,
  payload: DashboardSessionPayload | DashboardCreateLocalRowPayload,
  groupId?: SessionGroupId,
): DashboardPersistentFilterCandidate {
  if (payload.type === "session") {
    return {
      kind: "session",
      id,
      projectId: payload.row.worktree.projectId,
      ...(groupId === undefined ? {} : { groupId }),
      visibleFields: payload.presentation,
      conditionValues: {
        status: payload.pendingStart === undefined ? payload.row.session.status.value : "starting",
        agent: payload.row.session.harness.provider,
      },
    };
  }
  const conditionValues: DashboardPersistentFilterCandidate["conditionValues"] = {};
  if (payload.row.status === "pending") {
    conditionValues.status = "starting";
    if (payload.row.harnessProvider !== undefined) {
      conditionValues.agent = payload.row.harnessProvider;
    }
  }
  return {
    kind: "optimistic",
    id,
    projectId: payload.row.projectId,
    visibleFields: payload.presentation,
    conditionValues,
  };
}

function dashboardRoots(
  projects: readonly ProjectRows[],
  projection: DashboardPersistentFilterProjection | undefined,
  orderingMode: GroupOrderingMode,
  groupHeaderActionVisibility: DashboardGroupHeaderActionVisibility,
): DashboardTreeNode[] {
  const applied = projection?.source === "applied" && projection.active;
  return projects.flatMap((projectRows, index) => [
    ...(index === 0 ? [] : [projectGapNode(projectRows.project.id)]),
    projectNode(projectRows, projection, applied, orderingMode, groupHeaderActionVisibility),
  ]);
}

function projectNode(
  projectRows: ProjectRows,
  projection: DashboardPersistentFilterProjection | undefined,
  applied: boolean,
  orderingMode: GroupOrderingMode,
  groupHeaderActionVisibility: DashboardGroupHeaderActionVisibility,
): DashboardTreeNode {
  const visibleRootRows = admittedRows(projectRows.rootRows, projection, applied);
  const groupNodes = [...projectRows.groups]
    .sort(compareProjectGroups)
    .map((group) => groupNode(group, projection, applied, groupHeaderActionVisibility));
  const rootNodes = visibleRootRows.map((row) => rowNode(row, projection));
  const children =
    orderingMode === "groups-first"
      ? [...groupNodes, ...rootNodes]
      : interleaveGroupAndRootNodes(groupNodes, rootNodes);
  if (projectRows.rows.length === 0) {
    children.push(emptyProjectNode(projectRows.project));
  }
  const match = projection?.projects.get(projectRows.project.id);
  const payload: DashboardProjectHeaderPayload = {
    type: "projectHeader",
    project: projectRows.project,
    collapsed: projectRows.collapsed,
    groupCount: projectRows.groups.length,
    ...(match === undefined ? {} : { persistentFilterMatch: match }),
  };
  return {
    id: dashboardRowIds.project(projectRows.project.id),
    payload,
    cells: PROJECT_CELLS,
    defaultCell: "identity",
    ...(children.length === 0 ? {} : { children, expanded: !projectRows.collapsed }),
  };
}

function groupNode(
  groupRows: ProjectGroupRows,
  projection: DashboardPersistentFilterProjection | undefined,
  applied: boolean,
  actionVisibility: DashboardGroupHeaderActionVisibility,
): DashboardTreeNode {
  const visibleRows = admittedRows(groupRows.rows, projection, applied);
  const match = projection?.groups.get(groupRows.group.id);
  const payload: DashboardGroupHeaderPayload = {
    type: "groupHeader",
    group: groupRows.group,
    collapsed: groupRows.collapsed,
    sessionCount: groupRows.group.sessionIds.length,
    visibleSessionCount: visibleRows.filter((row) => row.type === "session").length,
    ...(match === undefined ? {} : { persistentFilterMatch: match }),
  };
  const children = [
    ...visibleRows.map((row) => rowNode(row, projection)),
    groupFrameEndNode(groupRows.group.id),
  ];
  return {
    id: dashboardRowIds.group(groupRows.group.id),
    payload,
    cells: groupHeaderCells(actionVisibility),
    defaultCell: "identity",
    children,
    expanded: !groupRows.collapsed,
  };
}

function groupHeaderCells(
  visibility: DashboardGroupHeaderActionVisibility,
): readonly DashboardCellId[] {
  const cells: DashboardCellId[] = ["identity"];
  if (visibility.quickSession) cells.push("quickSession");
  if (visibility.menu) cells.push("menu");
  return cells;
}

function groupFrameEndNode(groupId: SessionGroupId): DashboardTreeNode {
  return {
    id: dashboardRowIds.groupFrameEnd(groupId),
    payload: { type: "groupFrameEnd", groupId },
    cells: [],
  };
}

function admittedRows<Row extends DashboardSessionPayload | DashboardCreateLocalRowPayload>(
  rows: readonly Row[],
  projection: DashboardPersistentFilterProjection | undefined,
  applied: boolean,
): readonly Row[] {
  return applied
    ? rows.filter((row) => projection?.rows.get(rowIdForPayload(row))?.matched === true)
    : rows;
}

function compareProjectGroups(left: ProjectGroupRows, right: ProjectGroupRows): number {
  return (
    left.group.name.localeCompare(right.group.name) || left.group.id.localeCompare(right.group.id)
  );
}

function interleaveGroupAndRootNodes(
  groupNodes: readonly DashboardTreeNode[],
  rootNodes: readonly DashboardTreeNode[],
): DashboardTreeNode[] {
  return [
    ...groupNodes.map((node, index) => ({
      kind: "group" as const,
      label: node.payload.type === "groupHeader" ? node.payload.group.name : "",
      index,
      node,
    })),
    ...rootNodes.map((node, index) => ({
      kind: "row" as const,
      label:
        node.payload.type === "session" || node.payload.type === "createLocalRow"
          ? node.payload.presentation.title
          : "",
      index,
      node,
    })),
  ]
    .sort((left, right) => {
      const labelOrder = left.label.localeCompare(right.label);
      if (labelOrder !== 0) {
        return labelOrder;
      }
      if (left.kind !== right.kind) {
        return left.kind === "group" ? -1 : 1;
      }
      return left.kind === "group"
        ? left.node.id.localeCompare(right.node.id)
        : left.index - right.index;
    })
    .map(({ node }) => node);
}

function rowNode(
  payload: DashboardSessionPayload | DashboardCreateLocalRowPayload,
  projection: DashboardPersistentFilterProjection | undefined,
): DashboardTreeNode {
  const id = rowIdForPayload(payload);
  const match = projection?.rows.get(id);
  const decorated = match === undefined ? payload : { ...payload, persistentFilterMatch: match };
  return payload.type === "session"
    ? { id, payload: decorated, cells: SESSION_CELLS, defaultCell: "identity" }
    : { id, payload: decorated, cells: [] };
}

function emptyProjectNode(project: DashboardProjectView): DashboardTreeNode {
  return {
    id: dashboardRowIds.empty(project.id),
    payload: { type: "emptyProject", project },
    cells: EMPTY_PROJECT_CELLS,
    defaultCell: "addSession",
  };
}

function projectGapNode(projectId: ProjectId): DashboardTreeNode {
  return {
    id: dashboardRowIds.gap(projectId),
    payload: { type: "projectGap", projectId },
    cells: [],
  };
}

function decorateDashboardProjection(
  projection: TreeGridProjection<DashboardRowId, DashboardCellId, DashboardTreePayload>,
  focus: DashboardFocus | undefined,
  persistentFilter: DashboardPersistentFilterProjection | undefined,
): DashboardTreeProjection {
  const rowById = new Map<DashboardRowId, DashboardTreeRow>();
  const focusedRowCandidate =
    focus === undefined || !projection.visibleIndexById.has(focus.rowId)
      ? undefined
      : projection.rowById.get(focus.rowId);
  const focusedRow =
    focus !== undefined && focusedRowCandidate?.cells.includes(focus.cellId)
      ? focusedRowCandidate
      : undefined;
  for (const row of projection.rowById.values()) {
    let decorated: DashboardTreeRow = row;
    if (focus !== undefined && focusedRow?.id === row.id) {
      decorated = { ...decorated, focusedCellId: focus.cellId };
    }
    if (row.payload.type === "groupHeader" && focusedRow?.parentId === row.id) {
      decorated = { ...decorated, containsFocusedRow: true };
    }
    rowById.set(row.id, decorated);
  }
  const visibleRows = projection.visibleRows.map((row) => {
    const decorated = rowById.get(row.id);
    if (decorated === undefined) {
      throw new Error(`Projected dashboard row is missing: ${row.id}`);
    }
    return decorated;
  });
  return {
    rowById,
    visibleRows,
    visibleIndexById: projection.visibleIndexById,
    collapsedAncestorById: projection.collapsedAncestorById,
    ...(persistentFilter === undefined ? {} : { persistentFilter }),
  };
}

import type { ProjectId, SessionId } from "@station/contracts";
import { worktreeRowVisibleFields } from "../components/WorktreeRow/rowInput.js";
import type {
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
  session: (sessionId: SessionId): DashboardRowId => `session:${sessionId}` as DashboardRowId,
  create: (localId: string): DashboardRowId => `create:${localId}` as DashboardRowId,
  empty: (projectId: ProjectId): DashboardRowId => `empty:${projectId}` as DashboardRowId,
  gap: (projectId: ProjectId): DashboardRowId => `gap:${projectId}` as DashboardRowId,
} as const;

export type DashboardCellId = "identity" | "shell" | "quickSession" | "defaultAgent" | "addSession";

export type DashboardFocus = TreeGridCursor<DashboardRowId, DashboardCellId>;

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

export type DashboardProjectHeaderPayload = {
  readonly type: "projectHeader";
  readonly project: DashboardProjectView;
  readonly collapsed: boolean;
  readonly persistentFilterMatch?: DashboardPersistentFilterProjectMatch;
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
  | DashboardSessionPayload
  | DashboardCreateLocalRowPayload
  | DashboardEmptyProjectPayload
  | DashboardProjectGapPayload;

export type DashboardTreeRow = Omit<
  TreeGridRow<DashboardCellId, DashboardTreePayload>,
  "id" | "parentId"
> & {
  readonly id: DashboardRowId;
  readonly parentId?: DashboardRowId;
  /** Cursor decoration rebuilds row objects; row identity is not cursor-independent. */
  readonly focusedCellId?: DashboardCellId;
};

export type DashboardTreeProjection = Omit<
  TreeGridProjection<DashboardCellId, DashboardTreePayload>,
  "rowById" | "visibleRows"
> & {
  readonly rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>;
  readonly visibleRows: readonly DashboardTreeRow[];
  readonly persistentFilter?: DashboardPersistentFilterProjection;
};

type DashboardTreeNode = Omit<
  TreeGridNode<DashboardCellId, DashboardTreePayload>,
  "id" | "children"
> & {
  readonly id: DashboardRowId;
  readonly children?: readonly DashboardTreeNode[];
};

type MergedDashboardRow =
  | { readonly type: "session"; readonly row: DashboardSessionRow }
  | { readonly type: "createLocalRow"; readonly row: DashboardCreateSessionLocalRow };

type ProjectRows = {
  readonly project: DashboardProjectView;
  readonly collapsed: boolean;
  readonly rows: readonly (DashboardSessionPayload | DashboardCreateLocalRowPayload)[];
};

const PROJECT_CELLS = ["identity", "shell", "quickSession", "defaultAgent"] as const;
const SESSION_CELLS = ["identity"] as const;
const EMPTY_PROJECT_CELLS = ["addSession"] as const;

export function selectDashboardTree(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen: DashboardScreenView,
): DashboardTreeProjection {
  const sessionRows = selectDashboardSessionRows(snapshot);
  const localRows = visibleCreateSessionLocalRows(snapshot, state);
  const projects = snapshot.projects.map((project) => ({
    project,
    collapsed: state.collapsedProjectIds.has(project.id),
    rows: mergeDashboardRows(
      sessionRows.filter((row) => row.worktree.projectId === project.id),
      localRows.filter((row) => row.projectId === project.id),
      state,
    ).map((row) =>
      row.type === "session" ? sessionPayload(row.row, state) : createLocalPayload(row.row),
    ),
  }));
  const persistentFilter = selectDashboardPersistentFilter({
    candidates: projects.flatMap((project) =>
      project.rows.map((row) => persistentFilterCandidate(rowIdForPayload(row), row)),
    ),
    projects: projects.map(({ project }) => ({
      projectId: project.id,
      projectLabel: project.label,
    })),
    screen: activeScreen,
    ...(state.persistentFilter === undefined ? {} : { applied: state.persistentFilter }),
  });
  const roots = dashboardRoots(projects, persistentFilter);
  const idByValue = dashboardIdsByValue(roots);
  return decorateDashboardProjection(
    projectTreeGrid(roots),
    idByValue,
    state.dashboardFocus,
    persistentFilter,
  );
}

function dashboardRoots(
  projects: readonly ProjectRows[],
  projection: DashboardPersistentFilterProjection | undefined,
): DashboardTreeNode[] {
  const applied = projection?.source === "applied" && projection.active;
  const visibleProjects = applied
    ? projects.filter(({ project }) => projection.projects.get(project.id)?.matched === true)
    : projects;
  return visibleProjects.flatMap((projectRows, index) => [
    ...(index === 0 ? [] : [projectGapNode(projectRows.project.id)]),
    projectNode(projectRows, projection, applied),
  ]);
}

function projectNode(
  projectRows: ProjectRows,
  projection: DashboardPersistentFilterProjection | undefined,
  applied: boolean,
): DashboardTreeNode {
  const visibleRows = applied
    ? projectRows.rows.filter((row) => projection?.rows.get(rowIdForPayload(row))?.matched === true)
    : projectRows.rows;
  const children: DashboardTreeNode[] = visibleRows.map((row) => rowNode(row, projection));
  if (projectRows.rows.length === 0) {
    children.push(emptyProjectNode(projectRows.project));
  }
  const match = projection?.projects.get(projectRows.project.id);
  const payload: DashboardProjectHeaderPayload = {
    type: "projectHeader",
    project: projectRows.project,
    collapsed: projectRows.collapsed,
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

function persistentFilterCandidate(
  id: DashboardRowId,
  payload: DashboardSessionPayload | DashboardCreateLocalRowPayload,
): DashboardPersistentFilterCandidate {
  if (payload.type === "session") {
    return {
      kind: "session",
      id,
      projectId: payload.row.worktree.projectId,
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
    ...state.localRows.pendingCreate.map((row) => ({ ...row, status: "pending" as const })),
    ...state.localRows.failedCreate.map((row) => ({ ...row, status: "failed" as const })),
  ].filter((row) => !canonicalProjectBranches.has(`${row.projectId}\u0000${row.branch}`));
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

function rowIdForPayload(
  payload: DashboardSessionPayload | DashboardCreateLocalRowPayload,
): DashboardRowId {
  return payload.type === "session"
    ? dashboardRowIds.session(payload.row.id)
    : dashboardRowIds.create(payload.row.localId);
}

function dashboardIdsByValue(
  roots: readonly DashboardTreeNode[],
): ReadonlyMap<string, DashboardRowId> {
  const ids = new Map<string, DashboardRowId>();
  const visit = (node: DashboardTreeNode): void => {
    ids.set(node.id, node.id);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return ids;
}

function decorateDashboardProjection(
  projection: TreeGridProjection<DashboardCellId, DashboardTreePayload>,
  idByValue: ReadonlyMap<string, DashboardRowId>,
  focus: DashboardFocus | undefined,
  persistentFilter: DashboardPersistentFilterProjection | undefined,
): DashboardTreeProjection {
  const rowById = new Map<DashboardRowId, DashboardTreeRow>();
  for (const row of projection.rowById.values()) {
    const id = requiredDashboardId(idByValue, row.id);
    const decorated: DashboardTreeRow = {
      id,
      payload: row.payload,
      cells: row.cells,
      depth: row.depth,
      ...(row.defaultCell === undefined ? {} : { defaultCell: row.defaultCell }),
      ...(row.parentId === undefined
        ? {}
        : { parentId: requiredDashboardId(idByValue, row.parentId) }),
      ...(focus?.rowId === id && row.cells.includes(focus.cellId)
        ? { focusedCellId: focus.cellId }
        : {}),
    };
    rowById.set(id, decorated);
  }
  return {
    rowById,
    visibleRows: projection.visibleRows.map((row) =>
      requiredDashboardRow(rowById, requiredDashboardId(idByValue, row.id)),
    ),
    visibleIndexById: projection.visibleIndexById,
    collapsedAncestorById: projection.collapsedAncestorById,
    ...(persistentFilter === undefined ? {} : { persistentFilter }),
  };
}

function requiredDashboardId(ids: ReadonlyMap<string, DashboardRowId>, id: string): DashboardRowId {
  const dashboardId = ids.get(id);
  if (dashboardId === undefined) {
    throw new Error(`Dashboard row id was not constructed by dashboardRowIds: ${id}`);
  }
  return dashboardId;
}

function requiredDashboardRow(
  rows: ReadonlyMap<DashboardRowId, DashboardTreeRow>,
  id: DashboardRowId,
): DashboardTreeRow {
  const row = rows.get(id);
  if (row === undefined) {
    throw new Error(`Projected dashboard row is missing: ${id}`);
  }
  return row;
}

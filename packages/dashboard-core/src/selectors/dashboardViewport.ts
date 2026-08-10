import { clampDashboardScrollOffset, dashboardBodyRows } from "../components/Dashboard/layout.js";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "../state/types.js";
import type { DashboardPersistentFilterProjection } from "./dashboardPersistentFilter.js";
import type { DashboardSessionRow } from "./dashboardSessionRows.js";
import {
  type DashboardRowId,
  type DashboardTreeRow,
  selectDashboardTree,
} from "./dashboardTree.js";
import { type KeyedChoice, keyChoices } from "./selectors.js";

export type DashboardViewport = {
  readonly bodyRows: number;
  readonly clampedScrollOffset: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
  /** Rows clipped to the current terminal body window. */
  readonly rows: readonly DashboardTreeRow[];
  /** Exact full-projection lookup, including descendants hidden only by collapse. */
  readonly rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>;
  readonly rowChoices: readonly KeyedChoice<DashboardSessionRow>[];
  readonly displayRowChoices: readonly KeyedChoice<DashboardSessionRow>[];
  readonly sessionOverflow: DashboardSessionOverflow;
  readonly persistentFilter?: DashboardPersistentFilterProjection;
};

/** Session-row counts (not raw tree-row counts) for the scroll-overflow labels. */
export type DashboardSessionOverflow = {
  readonly above: number;
  readonly below: number;
  readonly visible: number;
  readonly total: number;
};

type DashboardViewportState = DashboardViewState & { readonly screen?: DashboardScreenView };

export function selectDashboardViewport(
  snapshot: DashboardSnapshotView,
  state: DashboardViewportState,
  activeScreen?: DashboardScreenView,
): DashboardViewport {
  const selectedScreen = activeScreen ?? state.screen ?? { name: "dashboard" };
  const tree = selectDashboardTree(snapshot, state, selectedScreen);
  const bodyRows = dashboardBodyRows(state.terminalRows);
  const clampedScrollOffset = clampDashboardScrollOffset({
    bodyRows,
    itemCount: tree.visibleRows.length,
    scrollOffset: state.scrollOffset,
  });
  const rows = tree.visibleRows.slice(clampedScrollOffset, clampedScrollOffset + bodyRows);
  const hiddenAbove = clampedScrollOffset;
  const hiddenBelow = Math.max(0, tree.visibleRows.length - clampedScrollOffset - bodyRows);
  const displayRowChoices = keyChoices(displaySessionRows(rows));
  const pendingStartWorktreeIds = new Set(
    rows.flatMap(({ payload }) =>
      payload.type === "session" && payload.pendingStart !== undefined
        ? [payload.row.worktree.id]
        : [],
    ),
  );
  const above = countSessionRows(tree.visibleRows.slice(0, clampedScrollOffset));
  const visible = countSessionRows(rows);
  const total = countSessionRows(tree.visibleRows);
  return {
    bodyRows,
    clampedScrollOffset,
    hiddenAbove,
    hiddenBelow,
    rows,
    rowById: tree.rowById,
    rowChoices: displayRowChoices.filter(
      (choice) => !pendingStartWorktreeIds.has(choice.value.worktree.id),
    ),
    displayRowChoices,
    sessionOverflow: { above, below: total - above - visible, visible, total },
    ...(tree.persistentFilter === undefined ? {} : { persistentFilter: tree.persistentFilter }),
  };
}

function displaySessionRows(rows: readonly DashboardTreeRow[]): DashboardSessionRow[] {
  return rows.flatMap(({ payload }) =>
    payload.type === "session" && payload.pendingRemove === undefined ? [payload.row] : [],
  );
}

function countSessionRows(rows: readonly DashboardTreeRow[]): number {
  return rows.filter(
    ({ payload }) => payload.type === "session" || payload.type === "createLocalRow",
  ).length;
}

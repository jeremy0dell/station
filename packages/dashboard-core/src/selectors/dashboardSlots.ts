import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "../state/types.js";
import type { DashboardPersistentFilterProjection } from "./dashboardPersistentFilter.js";
import type { DashboardSessionRow } from "./dashboardSessionRows.js";
import {
  type DashboardRowId,
  type DashboardTreeProjection,
  type DashboardTreeRow,
  selectDashboardTree,
} from "./dashboardTree.js";
import {
  type KeyedChoice,
  keyedSelectionChoices,
  type SelectionChoice,
  selectionChoices,
} from "./selectors.js";

/** Session-item counts around the renderer-reported semantic visibility window. */
export type DashboardSessionOverflow = {
  readonly above: number;
  readonly below: number;
  readonly visible: number;
  readonly total: number;
};

/**
 * Keyboard slots and overflow derived from semantic identities currently intersecting the
 * renderer viewport. No item count, terminal height, or coordinate enters this selector.
 */
export type DashboardSlots = {
  readonly tree: DashboardTreeProjection;
  readonly rowChoices: readonly KeyedChoice<DashboardSessionRow>[];
  readonly displayRowChoices: readonly SelectionChoice<DashboardSessionRow>[];
  readonly sessionOverflow: DashboardSessionOverflow;
  readonly semanticOverflow: { readonly above: boolean; readonly below: boolean };
  readonly persistentFilter?: DashboardPersistentFilterProjection;
};

export function selectDashboardSlots(
  snapshot: DashboardSnapshotView,
  state: DashboardViewState,
  activeScreen?: DashboardScreenView,
  visibleRowIds?: readonly DashboardRowId[],
): DashboardSlots {
  const selectedScreen = activeScreen ?? { name: "dashboard" };
  const tree = selectDashboardTree(snapshot, state, selectedScreen);
  return selectDashboardSlotsForTree(tree, visibleRowIds);
}

/** Derives renderer-local slots from a semantic tree that is already projected. */
export function selectDashboardSlotsForTree(
  tree: DashboardTreeProjection,
  visibleRowIds?: readonly DashboardRowId[],
): DashboardSlots {
  const rows = visibleTreeRows(tree, visibleRowIds);
  const displayRowChoices = selectionChoices(displaySessionRows(rows));
  const pendingStartWorktreeIds = new Set(
    rows.flatMap(({ payload }) =>
      payload.type === "session" && payload.pendingStart !== undefined
        ? [payload.row.worktree.id]
        : [],
    ),
  );
  return {
    tree,
    rowChoices: keyedSelectionChoices(displayRowChoices).filter(
      (choice) => !pendingStartWorktreeIds.has(choice.value.worktree.id),
    ),
    displayRowChoices,
    sessionOverflow: sessionOverflow(tree.visibleRows, rows),
    semanticOverflow: semanticOverflow(tree.visibleRows, rows),
    ...(tree.persistentFilter === undefined ? {} : { persistentFilter: tree.persistentFilter }),
  };
}

function visibleTreeRows(
  tree: DashboardTreeProjection,
  visibleRowIds: readonly DashboardRowId[] | undefined,
): readonly DashboardTreeRow[] {
  if (visibleRowIds === undefined) return tree.visibleRows;
  const visible = new Set(visibleRowIds);
  return tree.visibleRows.filter((row) => visible.has(row.id));
}

function displaySessionRows(rows: readonly DashboardTreeRow[]): DashboardSessionRow[] {
  return rows.flatMap(({ payload }) =>
    payload.type === "session" && payload.pendingRemove === undefined ? [payload.row] : [],
  );
}

function sessionOverflow(
  allRows: readonly DashboardTreeRow[],
  visibleRows: readonly DashboardTreeRow[],
): DashboardSessionOverflow {
  const total = countSessionItems(allRows);
  if (visibleRows.length === 0) {
    return { above: 0, below: total, visible: 0, total };
  }
  const firstId = visibleRows[0]?.id;
  const lastId = visibleRows.at(-1)?.id;
  const first = allRows.findIndex((row) => row.id === firstId);
  const last = allRows.findIndex((row) => row.id === lastId);
  const visible = countSessionItems(visibleRows);
  const above = countSessionItems(allRows.slice(0, Math.max(0, first)));
  const below = countSessionItems(allRows.slice(last + 1));
  return { above, below, visible, total };
}

function semanticOverflow(
  allRows: readonly DashboardTreeRow[],
  visibleRows: readonly DashboardTreeRow[],
): DashboardSlots["semanticOverflow"] {
  if (visibleRows.length === 0) return { above: false, below: false };
  return {
    above: visibleRows[0]?.id !== allRows[0]?.id,
    below: visibleRows.at(-1)?.id !== allRows.at(-1)?.id,
  };
}

function countSessionItems(rows: readonly DashboardTreeRow[]): number {
  return rows.filter(
    ({ payload }) => payload.type === "session" || payload.type === "createLocalRow",
  ).length;
}

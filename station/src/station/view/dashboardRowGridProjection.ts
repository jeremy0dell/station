import {
  dashboardRowGridInput,
  layoutWorktreeRowGrid,
  textSegment,
  type DashboardRowId,
  type DashboardTreeProjection,
  type DashboardTreeRow,
  type RowGridLayout,
  type RowGridRowInput,
} from "@station/dashboard-core/selectors";
import { groupFrameContentColumns } from "./GroupFrameView.js";

const COLUMN_HEADER_ROW_ID = "__column_header__";
const NO_SELECTION_SLOTS: ReadonlyMap<string, string> = new Map();

export type DashboardRowGridProjection = {
  headerLayout: RowGridLayout | undefined;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
};

type RowGridLayouter = typeof layoutWorktreeRowGrid;

export type DashboardRowGridProjector = {
  project(tree: DashboardTreeProjection, columns: number): DashboardRowGridProjection;
};

/**
 * Keeps cross-row terminal-cell negotiation stable across renderer-only visibility updates.
 * Semantic tree or width changes still invalidate the one-entry cache.
 */
export function createDashboardRowGridProjector(
  layoutRows: RowGridLayouter = layoutWorktreeRowGrid,
): DashboardRowGridProjector {
  let cached:
    | {
        columns: number;
        rowById: DashboardTreeProjection["rowById"];
        rows: DashboardTreeProjection["visibleRows"];
        value: DashboardRowGridProjection;
      }
    | undefined;
  return {
    project(tree, columns) {
      const normalizedColumns = Math.max(1, Math.floor(columns));
      if (
        cached !== undefined &&
        cached.rows === tree.visibleRows &&
        cached.rowById === tree.rowById &&
        cached.columns === normalizedColumns
      ) {
        return cached.value;
      }
      const value = projectDashboardRowGrid(
        tree.visibleRows,
        tree.rowById,
        normalizedColumns,
        layoutRows,
      );
      cached = {
        columns: normalizedColumns,
        rowById: tree.rowById,
        rows: tree.visibleRows,
        value,
      };
      return value;
    },
  };
}

function columnHeaderRowInput(): RowGridRowInput {
  return {
    id: COLUMN_HEADER_ROW_ID,
    cells: {
      identity: { key: "identity", segments: [textSegment(" ".repeat(7))], importance: "required" },
      title: { key: "title", segments: [textSegment("SESSION")], importance: "required" },
      agent: { key: "agent", segments: [textSegment("AGENT")], importance: "optional" },
      activity: { key: "activity", segments: [textSegment("STATUS")], importance: "optional" },
    },
    // The ladder sheds diff first, so the joining middot can never be orphaned from PR.
    metadataGroups: { diff: [textSegment("DIFF ·")], pr: [textSegment("PR")] },
  };
}

function projectDashboardRowGrid(
  rows: readonly DashboardTreeRow[],
  rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>,
  columns: number,
  layoutRows: RowGridLayouter,
): DashboardRowGridProjection {
  const rowInputs = rows.flatMap((row) => {
    const input = dashboardRowGridInput(row, NO_SELECTION_SLOTS);
    return input === undefined ? [] : [input];
  });
  const fullLayouts = layoutRows({
    columns,
    rows: [columnHeaderRowInput(), ...rowInputs],
  });
  const framedRowInputs = rowInputs.filter((input) => hasGroupParent(input, rowById));
  const framedLayouts =
    framedRowInputs.length === 0
      ? []
      : layoutRows({
          columns: groupFrameContentColumns(columns),
          rows: [columnHeaderRowInput(), ...framedRowInputs],
        });
  const headerLayout = fullLayouts.find((layout) => layout.id === COLUMN_HEADER_ROW_ID);
  const framedByItem = new Map(framedLayouts.map((layout) => [layout.id, layout]));
  const layoutByItem = new Map(
    fullLayouts
      .filter((layout) => layout.id !== COLUMN_HEADER_ROW_ID)
      .map((layout) => [
        layout.id,
        hasGroupParent(layout, rowById) ? (framedByItem.get(layout.id) ?? layout) : layout,
      ]),
  );
  return { headerLayout, layoutByItem };
}

function hasGroupParent(
  item: Pick<RowGridRowInput, "id">,
  rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>,
): boolean {
  const row = rowById.get(item.id as DashboardRowId);
  const parent = row?.parentId === undefined ? undefined : rowById.get(row.parentId);
  return parent?.payload.type === "groupHeader";
}

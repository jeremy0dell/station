import { expect, it } from "vitest";
import {
  moveTreeGridCursor,
  projectTreeGrid,
  reconcileTreeGridCursor,
  type TreeGridCursor,
  type TreeGridNode,
  treeGridCursorForRow,
} from "../../src/treeGrid.js";

declare const rowIdBrand: unique symbol;

type RowId = string & { readonly [rowIdBrand]: true };
type CellId = "identity" | "action";
type Payload = { readonly kind: "row" };

it("preserves branded row identity across tree-grid mechanics", () => {
  expect(true).toBe(true);
});

const rootId = "root" as RowId;
const childId = "child" as RowId;
const roots: readonly TreeGridNode<RowId, CellId, Payload>[] = [
  {
    id: rootId,
    payload: { kind: "row" },
    cells: ["identity"],
    expanded: false,
    children: [{ id: childId, payload: { kind: "row" }, cells: ["action"] }],
  },
];
const projection = projectTreeGrid(roots);
const cursor: TreeGridCursor<RowId, CellId> = { rowId: rootId, cellId: "identity" };

const visibleRowId: RowId | undefined = projection.visibleRows[0]?.id;
const parentId: RowId | undefined = projection.rowById.get(childId)?.parentId;
const collapsedAncestorId: RowId | undefined = projection.collapsedAncestorById.get(childId);
const createdRowId: RowId | undefined = treeGridCursorForRow({ projection, rowId: rootId })?.rowId;
const movedRowId: RowId = moveTreeGridCursor({
  projection,
  cursor,
  direction: "down",
}).rowId;
const reconciledRowId: RowId | undefined = reconcileTreeGridCursor({
  previous: projection,
  next: projection,
  cursor,
})?.rowId;

// @ts-expect-error Branded projections reject unbranded row lookup keys.
projection.rowById.get("root");

void [visibleRowId, parentId, collapsedAncestorId, createdRowId, movedRowId, reconciledRowId];

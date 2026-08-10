/** Normalized immutable structural input for a tree-grid projection. */
export type TreeGridNode<RowId extends string, CellId extends string, Payload> = {
  readonly id: RowId;
  readonly payload: Payload;
  readonly cells: readonly CellId[];
  readonly defaultCell?: CellId;
  readonly children?: readonly TreeGridNode<RowId, CellId, Payload>[];
  readonly expanded?: boolean;
};

export type TreeGridRow<RowId extends string, CellId extends string, Payload> = {
  readonly id: RowId;
  readonly payload: Payload;
  readonly cells: readonly CellId[];
  readonly defaultCell?: CellId;
  readonly depth: number;
  readonly parentId?: RowId;
};

/** All supplied nodes plus the visible preorder and collapse ancestry needed for recovery. */
export type TreeGridProjection<RowId extends string, CellId extends string, Payload> = {
  readonly rowById: ReadonlyMap<RowId, TreeGridRow<RowId, CellId, Payload>>;
  readonly visibleRows: readonly TreeGridRow<RowId, CellId, Payload>[];
  readonly visibleIndexById: ReadonlyMap<RowId, number>;
  readonly collapsedAncestorById: ReadonlyMap<RowId, RowId>;
};

/** Stable row and cell identity independent of a row's structural parent. */
export type TreeGridCursor<RowId extends string, CellId extends string> = {
  readonly rowId: RowId;
  readonly cellId: CellId;
};

export type TreeGridDirection = "up" | "down" | "left" | "right";

/** One eligibility rule shared by cursor creation, movement, and reconciliation. */
export type TreeGridNavigationPolicy<RowId extends string, CellId extends string, Payload> = (
  row: TreeGridRow<RowId, CellId, Payload>,
) => boolean;

export function projectTreeGrid<RowId extends string, CellId extends string, Payload>(
  roots: readonly TreeGridNode<RowId, CellId, Payload>[],
): TreeGridProjection<RowId, CellId, Payload> {
  const rowById = new Map<RowId, TreeGridRow<RowId, CellId, Payload>>();
  const visibleRows: TreeGridRow<RowId, CellId, Payload>[] = [];
  const visibleIndexById = new Map<RowId, number>();
  const collapsedAncestorById = new Map<RowId, RowId>();

  const visit = (
    node: TreeGridNode<RowId, CellId, Payload>,
    depth: number,
    parentId: RowId | undefined,
    visible: boolean,
    collapsedAncestorId: RowId | undefined,
  ): void => {
    if (rowById.has(node.id)) {
      throw new Error(`Duplicate tree-grid row id: ${node.id}`);
    }
    if (node.defaultCell !== undefined && !node.cells.includes(node.defaultCell)) {
      throw new Error(
        `Tree-grid default cell ${node.defaultCell} does not belong to row ${node.id}.`,
      );
    }

    const row: TreeGridRow<RowId, CellId, Payload> = {
      id: node.id,
      payload: node.payload,
      cells: node.cells,
      depth,
      ...(node.defaultCell === undefined ? {} : { defaultCell: node.defaultCell }),
      ...(parentId === undefined ? {} : { parentId }),
    };
    rowById.set(row.id, row);

    if (visible) {
      visibleIndexById.set(row.id, visibleRows.length);
      visibleRows.push(row);
    } else if (collapsedAncestorId !== undefined) {
      collapsedAncestorById.set(row.id, collapsedAncestorId);
    }

    const childrenVisible = visible && node.expanded !== false;
    const childCollapsedAncestorId = visible
      ? node.expanded === false
        ? node.id
        : undefined
      : collapsedAncestorId;
    for (const child of node.children ?? []) {
      visit(child, depth + 1, node.id, childrenVisible, childCollapsedAncestorId);
    }
  };

  for (const root of roots) {
    visit(root, 0, undefined, true, undefined);
  }

  return { rowById, visibleRows, visibleIndexById, collapsedAncestorById };
}

export function treeGridCursorForRow<RowId extends string, CellId extends string, Payload>(input: {
  projection: TreeGridProjection<RowId, CellId, Payload>;
  rowId: RowId;
  preferredCell?: CellId;
  policy?: TreeGridNavigationPolicy<RowId, CellId, Payload>;
}): TreeGridCursor<RowId, CellId> | undefined {
  const row = input.projection.rowById.get(input.rowId);
  if (
    row === undefined ||
    !input.projection.visibleIndexById.has(row.id) ||
    !rowEligible(row, input.policy)
  ) {
    return undefined;
  }
  const cellId =
    input.preferredCell !== undefined && row.cells.includes(input.preferredCell)
      ? input.preferredCell
      : defaultCell(row);
  return cellId === undefined ? undefined : { rowId: input.rowId, cellId };
}

export function moveTreeGridCursor<RowId extends string, CellId extends string, Payload>(input: {
  projection: TreeGridProjection<RowId, CellId, Payload>;
  cursor: TreeGridCursor<RowId, CellId>;
  direction: TreeGridDirection;
  policy?: TreeGridNavigationPolicy<RowId, CellId, Payload>;
}): TreeGridCursor<RowId, CellId> {
  const row = input.projection.rowById.get(input.cursor.rowId);
  const visibleIndex = input.projection.visibleIndexById.get(input.cursor.rowId);
  if (row === undefined || visibleIndex === undefined) {
    return input.cursor;
  }

  if (input.direction === "left" || input.direction === "right") {
    if (!rowEligible(row, input.policy)) {
      return input.cursor;
    }
    const cellIndex = row.cells.indexOf(input.cursor.cellId);
    if (cellIndex === -1) {
      return input.cursor;
    }
    const delta = input.direction === "left" ? -1 : 1;
    const nextIndex = Math.min(row.cells.length - 1, Math.max(0, cellIndex + delta));
    const cellId = row.cells[nextIndex];
    return cellId === undefined || cellId === input.cursor.cellId
      ? input.cursor
      : { rowId: input.cursor.rowId, cellId };
  }

  const delta = input.direction === "up" ? -1 : 1;
  for (
    let index = visibleIndex + delta;
    index >= 0 && index < input.projection.visibleRows.length;
    index += delta
  ) {
    const candidate = input.projection.visibleRows[index];
    if (candidate === undefined || !rowEligible(candidate, input.policy)) {
      continue;
    }
    const cursor = cursorForProjectedRow(candidate);
    if (cursor !== undefined) {
      return cursor;
    }
  }
  return input.cursor;
}

export function reconcileTreeGridCursor<
  RowId extends string,
  CellId extends string,
  Payload,
>(input: {
  previous: TreeGridProjection<RowId, CellId, Payload>;
  next: TreeGridProjection<RowId, CellId, Payload>;
  cursor: TreeGridCursor<RowId, CellId>;
  policy?: TreeGridNavigationPolicy<RowId, CellId, Payload>;
}): TreeGridCursor<RowId, CellId> | undefined {
  const exact = treeGridCursorForRow({
    projection: input.next,
    rowId: input.cursor.rowId,
    preferredCell: input.cursor.cellId,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  });
  if (exact !== undefined) {
    return exact;
  }

  // Collapse-hidden rows recover to the first visible eligible collapsed ancestor;
  // ordinary removal or filtering instead falls through to positional recovery.
  const collapsedAncestorId = input.next.collapsedAncestorById.get(input.cursor.rowId);
  if (collapsedAncestorId !== undefined) {
    const collapsedAncestor = treeGridCursorForRow({
      projection: input.next,
      rowId: collapsedAncestorId,
      ...(input.policy === undefined ? {} : { policy: input.policy }),
    });
    if (collapsedAncestor !== undefined) {
      return collapsedAncestor;
    }
  }

  const previousIndex = input.previous.visibleIndexById.get(input.cursor.rowId);
  if (previousIndex === undefined) {
    return undefined;
  }
  for (let index = previousIndex; index < input.next.visibleRows.length; index += 1) {
    const row = input.next.visibleRows[index];
    if (row !== undefined && rowEligible(row, input.policy)) {
      return cursorForProjectedRow(row);
    }
  }
  for (
    let index = Math.min(previousIndex - 1, input.next.visibleRows.length - 1);
    index >= 0;
    index -= 1
  ) {
    const row = input.next.visibleRows[index];
    if (row !== undefined && rowEligible(row, input.policy)) {
      return cursorForProjectedRow(row);
    }
  }
  return undefined;
}

function rowEligible<RowId extends string, CellId extends string, Payload>(
  row: TreeGridRow<RowId, CellId, Payload>,
  policy: TreeGridNavigationPolicy<RowId, CellId, Payload> | undefined,
): boolean {
  return row.cells.length > 0 && (policy?.(row) ?? true);
}

function defaultCell<RowId extends string, CellId extends string, Payload>(
  row: TreeGridRow<RowId, CellId, Payload>,
): CellId | undefined {
  return row.defaultCell ?? row.cells[0];
}

function cursorForProjectedRow<RowId extends string, CellId extends string, Payload>(
  row: TreeGridRow<RowId, CellId, Payload>,
): TreeGridCursor<RowId, CellId> | undefined {
  const cellId = defaultCell(row);
  return cellId === undefined ? undefined : { rowId: row.id, cellId };
}

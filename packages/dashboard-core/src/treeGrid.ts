/** Normalized immutable structural input for a tree-grid projection. */
export type TreeGridNode<CellId extends string, Payload> = {
  readonly id: string;
  readonly payload: Payload;
  readonly cells: readonly CellId[];
  readonly defaultCell?: CellId;
  readonly children?: readonly TreeGridNode<CellId, Payload>[];
  readonly expanded?: boolean;
};

export type TreeGridRow<CellId extends string, Payload> = {
  readonly id: string;
  readonly payload: Payload;
  readonly cells: readonly CellId[];
  readonly defaultCell?: CellId;
  readonly depth: number;
  readonly parentId?: string;
};

/** All supplied nodes plus the visible preorder and collapse ancestry needed for recovery. */
export type TreeGridProjection<CellId extends string, Payload> = {
  readonly rowById: ReadonlyMap<string, TreeGridRow<CellId, Payload>>;
  readonly visibleRows: readonly TreeGridRow<CellId, Payload>[];
  readonly visibleIndexById: ReadonlyMap<string, number>;
  readonly collapsedAncestorById: ReadonlyMap<string, string>;
};

/** Stable row and cell identity independent of a row's structural parent. */
export type TreeGridCursor<RowId extends string, CellId extends string> = {
  readonly rowId: RowId;
  readonly cellId: CellId;
};

export type TreeGridDirection = "up" | "down" | "left" | "right";

/** One eligibility rule shared by cursor creation, movement, and reconciliation. */
export type TreeGridNavigationPolicy<CellId extends string, Payload> = (
  row: TreeGridRow<CellId, Payload>,
) => boolean;

export function projectTreeGrid<CellId extends string, Payload>(
  roots: readonly TreeGridNode<CellId, Payload>[],
): TreeGridProjection<CellId, Payload> {
  const rowById = new Map<string, TreeGridRow<CellId, Payload>>();
  const visibleRows: TreeGridRow<CellId, Payload>[] = [];
  const visibleIndexById = new Map<string, number>();
  const collapsedAncestorById = new Map<string, string>();

  const visit = (
    node: TreeGridNode<CellId, Payload>,
    depth: number,
    parentId: string | undefined,
    visible: boolean,
    collapsedAncestorId: string | undefined,
  ): void => {
    if (rowById.has(node.id)) {
      throw new Error(`Duplicate tree-grid row id: ${node.id}`);
    }
    if (node.defaultCell !== undefined && !node.cells.includes(node.defaultCell)) {
      throw new Error(
        `Tree-grid default cell ${node.defaultCell} does not belong to row ${node.id}.`,
      );
    }

    const row: TreeGridRow<CellId, Payload> = {
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

export function treeGridCursorForRow<CellId extends string, Payload, RowId extends string>(input: {
  projection: TreeGridProjection<CellId, Payload>;
  rowId: RowId;
  preferredCell?: CellId;
  policy?: TreeGridNavigationPolicy<CellId, Payload>;
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

export function moveTreeGridCursor<CellId extends string, Payload, RowId extends string>(input: {
  projection: TreeGridProjection<CellId, Payload>;
  cursor: TreeGridCursor<RowId, CellId>;
  direction: TreeGridDirection;
  policy?: TreeGridNavigationPolicy<CellId, Payload>;
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
    const cursor = cursorForProjectedRow<RowId, CellId, Payload>(candidate);
    if (cursor !== undefined) {
      return cursor;
    }
  }
  return input.cursor;
}

export function reconcileTreeGridCursor<
  CellId extends string,
  Payload,
  RowId extends string,
>(input: {
  previous: TreeGridProjection<CellId, Payload>;
  next: TreeGridProjection<CellId, Payload>;
  cursor: TreeGridCursor<RowId, CellId>;
  policy?: TreeGridNavigationPolicy<CellId, Payload>;
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
      rowId: collapsedAncestorId as RowId,
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
      return cursorForProjectedRow<RowId, CellId, Payload>(row);
    }
  }
  for (
    let index = Math.min(previousIndex - 1, input.next.visibleRows.length - 1);
    index >= 0;
    index -= 1
  ) {
    const row = input.next.visibleRows[index];
    if (row !== undefined && rowEligible(row, input.policy)) {
      return cursorForProjectedRow<RowId, CellId, Payload>(row);
    }
  }
  return undefined;
}

function rowEligible<CellId extends string, Payload>(
  row: TreeGridRow<CellId, Payload>,
  policy: TreeGridNavigationPolicy<CellId, Payload> | undefined,
): boolean {
  return row.cells.length > 0 && (policy?.(row) ?? true);
}

function defaultCell<CellId extends string, Payload>(
  row: TreeGridRow<CellId, Payload>,
): CellId | undefined {
  return row.defaultCell ?? row.cells[0];
}

function cursorForProjectedRow<RowId extends string, CellId extends string, Payload>(
  row: TreeGridRow<CellId, Payload>,
): TreeGridCursor<RowId, CellId> | undefined {
  const cellId = defaultCell(row);
  return cellId === undefined ? undefined : { rowId: row.id as RowId, cellId };
}

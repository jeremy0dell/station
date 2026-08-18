export type SeparatableMenuItem = {
  readonly separatorBefore?: true;
};

export type VisibleMenuItem<Item> = {
  readonly item: Item;
  readonly itemIndex: number;
};

/** Keeps visible items contiguous while accounting for separator rows. */
export function visibleMenuItems<Item extends SeparatableMenuItem>(
  items: readonly Item[],
  availableRows: number,
): readonly VisibleMenuItem<Item>[] {
  const visible: VisibleMenuItem<Item>[] = [];
  let consumedRows = 0;

  for (const [itemIndex, item] of items.entries()) {
    const itemRows = item.separatorBefore === true ? 2 : 1;
    if (consumedRows + itemRows > availableRows) break;
    visible.push({ item, itemIndex });
    consumedRows += itemRows;
  }

  return visible;
}

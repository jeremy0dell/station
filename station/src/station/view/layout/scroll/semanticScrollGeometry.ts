export type SemanticItemGeometry<ItemId extends string> = {
  readonly id: ItemId;
  readonly top: number;
  readonly bottom: number;
};

/** Inclusive intersection at the top and exclusive intersection at the bottom. */
export function intersectingSemanticItems<ItemId extends string>(
  viewport: { readonly top: number; readonly bottom: number },
  items: readonly SemanticItemGeometry<ItemId>[],
): ItemId[] {
  return items
    .filter((item) => item.bottom > viewport.top && item.top < viewport.bottom)
    .map((item) => item.id);
}

/**
 * Resolves a viewport against top-to-bottom, non-overlapping semantic boxes.
 * With constant-time geometry lookup, steady-state work is logarithmic in all items plus the
 * intersecting boxes. The controller maintains that lookup at the renderer boundary.
 */
export function intersectingOrderedSemanticItems<ItemId extends string>(
  viewport: { readonly top: number; readonly bottom: number },
  itemIds: readonly ItemId[],
  geometryFor: (id: ItemId) => SemanticItemGeometry<ItemId> | undefined,
): ItemId[] {
  let low = 0;
  let high = itemIds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const id = itemIds[middle];
    const item = id === undefined ? undefined : geometryFor(id);
    if (item === undefined) {
      return intersectingSemanticItems(
        viewport,
        itemIds.flatMap((candidateId) => {
          const candidate = geometryFor(candidateId);
          return candidate === undefined ? [] : [candidate];
        }),
      );
    }
    if (item.bottom <= viewport.top) low = middle + 1;
    else high = middle;
  }

  const visible: ItemId[] = [];
  for (let index = low; index < itemIds.length; index += 1) {
    const id = itemIds[index];
    if (id === undefined) break;
    const item = geometryFor(id);
    if (item === undefined) continue;
    if (item.top >= viewport.bottom) break;
    if (item.bottom > viewport.top) visible.push(id);
  }
  return visible;
}

/** Cell delta that reveals a semantic box; oversized boxes align their leading edge. */
export function semanticRevealDelta(
  viewport: { readonly top: number; readonly bottom: number },
  item: { readonly top: number; readonly bottom: number },
  alignment: "nearest" | "start" | "end" = "nearest",
): number {
  const itemHeight = item.bottom - item.top;
  const viewportHeight = viewport.bottom - viewport.top;
  if (itemHeight >= viewportHeight) {
    return item.bottom > viewport.top && item.top < viewport.bottom
      ? 0
      : item.top - viewport.top;
  }
  if (alignment === "start") return item.top - viewport.top;
  if (alignment === "end") return item.bottom - viewport.bottom;
  if (item.top < viewport.top) return item.top - viewport.top;
  if (item.bottom > viewport.bottom) return item.bottom - viewport.bottom;
  return 0;
}

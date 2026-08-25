import type { ContextMenuItem, ContextMenuItemId } from "./types.js";

/** Resolves durable focus identity against the menu's current semantic items. */
export function resolveContextMenuActiveItem(
  items: readonly ContextMenuItem[],
  activeItemId: ContextMenuItemId | undefined,
): ContextMenuItem | undefined {
  return items.find((item) => item.id === activeItemId) ?? items[0];
}

/** Moves through semantic menu order while returning identity, never an item offset. */
export function moveContextMenuActiveItem(
  items: readonly ContextMenuItem[],
  activeItemId: ContextMenuItemId | undefined,
  delta: -1 | 1,
): ContextMenuItemId | undefined {
  const active = resolveContextMenuActiveItem(items, activeItemId);
  if (active === undefined) return undefined;
  const activePosition = items.findIndex((item) => item.id === active.id);
  return items[(activePosition + delta + items.length) % items.length]?.id;
}

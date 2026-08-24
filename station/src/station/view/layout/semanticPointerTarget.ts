import { type BaseRenderable, Renderable } from "@opentui/core";
import { semanticItemRenderableId } from "./scrollViewport.js";

/**
 * Resolves a terminal-cell pointer to a semantic child at the renderer boundary.
 * OpenTUI can report a scroll surface instead of its child at the final clipped cell.
 */
export function semanticItemIdAtPointer<ItemId extends string>(
  container: BaseRenderable | null,
  itemIds: readonly ItemId[],
  x: number,
  y: number,
): ItemId | undefined {
  if (container === null) return undefined;
  return itemIds.find((itemId) => {
    const renderable = container.findDescendantById(semanticItemRenderableId(itemId));
    return (
      renderable instanceof Renderable &&
      x >= renderable.screenX &&
      x < renderable.screenX + renderable.width &&
      y >= renderable.screenY &&
      y < renderable.screenY + renderable.height
    );
  });
}

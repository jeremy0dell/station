import { type BaseRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core";
import { semanticItemRenderableId } from "./scroll/scrollViewport.js";

/**
 * Resolves a terminal-cell pointer to a semantic child inside its measured scroll viewport.
 * OpenTUI can report the scroll surface at a clipped edge, so raw child geometry is accepted
 * only after the pointer is proven to be inside the viewport's painted content rectangle.
 */
export function semanticItemIdAtPointer<ItemId extends string>(
  container: BaseRenderable | null,
  viewportRenderableId: string,
  itemIds: readonly ItemId[],
  x: number,
  y: number,
): ItemId | undefined {
  if (container === null) return undefined;
  const scrollbox = container.findDescendantById(viewportRenderableId);
  if (!(scrollbox instanceof ScrollBoxRenderable) || !containsPoint(scrollbox.viewport, x, y)) {
    return undefined;
  }
  return itemIds.find((itemId) => {
    const renderable = container.findDescendantById(semanticItemRenderableId(itemId));
    return renderable instanceof Renderable && containsPoint(renderable, x, y);
  });
}

function containsPoint(
  renderable: Pick<Renderable, "screenX" | "screenY" | "width" | "height">,
  x: number,
  y: number,
): boolean {
  return (
    x >= renderable.screenX &&
    x < renderable.screenX + renderable.width &&
    y >= renderable.screenY &&
    y < renderable.screenY + renderable.height
  );
}

import { Renderable, type BaseRenderable, type ScrollBoxRenderable } from "@opentui/core";
import {
  intersectingOrderedSemanticItems,
  semanticRevealDelta,
  type SemanticItemGeometry,
} from "./semanticScrollGeometry.js";

export function semanticItemRenderableId(id: string): string {
  return `station-semantic-item:${id}`;
}

export type ScrollViewportController<ItemId extends string> = {
  readonly visibility: { visibleItemIds(): readonly ItemId[] | undefined };
  attach(viewport: ScrollBoxRenderable, itemIds: readonly ItemId[]): void;
  detach(viewport: ScrollBoxRenderable): void;
  reflow(): void;
  synchronize(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): readonly ItemId[] | undefined;
  scrollBy(cells: number): void;
  scrollPage(direction: -1 | 1): void;
  follow(itemId: ItemId | undefined): void;
};

/**
 * Owns the unavoidable translation between semantic identities and OpenTUI cell geometry.
 * A destruction-aware renderable index makes steady-state geometry lookup constant-time; semantic
 * node replacement rebuilds that index with one render-tree traversal. Callers can scroll/follow
 * identities but cannot make feature decisions from coordinates.
 */
export function createScrollViewportController<
  ItemId extends string,
>(): ScrollViewportController<ItemId> {
  let viewport: ScrollBoxRenderable | undefined;
  let layoutOwner: BaseRenderable | undefined;
  let orderedIds: readonly ItemId[] = [];
  let visibleIds: readonly ItemId[] | undefined;
  let followedId: ItemId | undefined;
  let followAlignment: "start" | "end" | undefined;
  let synchronizedScrollTop: number | undefined;
  let reflowQueued = false;
  let itemIndexDirty = true;
  const itemById = new Map<ItemId, Renderable>();
  const indexedItems = new Set<Renderable>();
  const listeners = new Set<() => void>();

  const scheduleReflow = (): void => {
    if (reflowQueued) return;
    reflowQueued = true;
    queueMicrotask(() => {
      reflowQueued = false;
      reflow();
    });
  };
  const markItemIndexDirty = (): void => {
    itemIndexDirty = true;
    scheduleReflow();
  };
  const clearItemIndex = (): void => {
    for (const item of indexedItems) item.off("destroyed", markItemIndexDirty);
    indexedItems.clear();
    itemById.clear();
  };
  const rebuildItemIndex = (): void => {
    clearItemIndex();
    const content = viewport?.content;
    if (content === undefined) {
      itemIndexDirty = true;
      return;
    }
    const itemIdByRenderableId = new Map(
      orderedIds.map((id) => [semanticItemRenderableId(id), id] as const),
    );
    const pending: BaseRenderable[] = [content];
    while (pending.length > 0 && itemById.size < itemIdByRenderableId.size) {
      const parent = pending.pop();
      if (parent === undefined) break;
      for (const child of parent.getChildren()) {
        if (child instanceof Renderable) {
          const itemId = itemIdByRenderableId.get(child.id);
          if (itemId !== undefined && !itemById.has(itemId)) {
            itemById.set(itemId, child);
            indexedItems.add(child);
            child.on("destroyed", markItemIndexDirty);
          }
        }
        pending.push(child);
      }
    }
    itemIndexDirty = itemById.size !== itemIdByRenderableId.size;
  };
  const ensureItemIndex = (): void => {
    if (itemIndexDirty) rebuildItemIndex();
  };
  const geometryFor = (id: ItemId): SemanticItemGeometry<ItemId> | undefined => {
    const item = itemById.get(id);
    if (item === undefined || item.isDestroyed) {
      itemIndexDirty = true;
      return undefined;
    }
    return geometry(id, item);
  };
  const synchronizeIndexed = (): void => {
    if (viewport === undefined) return;
    const next = viewport.viewport.height <= 0
      ? []
      : intersectingOrderedSemanticItems(
          {
            top: viewport.viewport.y,
            bottom: viewport.viewport.y + viewport.viewport.height,
          },
          orderedIds,
          geometryFor,
        );
    if (sameIds(visibleIds, next)) return;
    visibleIds = next;
    for (const listener of listeners) listener();
  };
  const synchronize = (): void => {
    ensureItemIndex();
    synchronizedScrollTop = viewport?.scrollTop;
    synchronizeIndexed();
  };
  const stopFollowing = (): void => {
    followedId = undefined;
    followAlignment = undefined;
  };
  const revealFollowedItemIndexed = (): void => {
    if (
      viewport === undefined ||
      viewport.viewport.height <= 0 ||
      followedId === undefined
    ) {
      return;
    }
    const item = geometryFor(followedId);
    if (item === undefined) return;
    const viewportTop = viewport.viewport.y;
    const viewportBottom = viewportTop + viewport.viewport.height;
    if (followAlignment !== undefined) {
      const anchoredDelta = semanticRevealDelta(
        { top: viewportTop, bottom: viewportBottom },
        item,
        followAlignment,
      );
      if (anchoredDelta < 0 && viewport.scrollTop <= 0) {
        followAlignment = undefined;
        return;
      }
      if (anchoredDelta !== 0) viewport.scrollBy(anchoredDelta);
      return;
    }
    const delta = semanticRevealDelta(
      { top: viewportTop, bottom: viewportBottom },
      item,
    );
    if (delta === 0) return;
    followAlignment = delta < 0 ? "start" : "end";
    viewport.scrollBy(delta);
  };
  const reflow = (): void => {
    ensureItemIndex();
    revealFollowedItemIndexed();
    synchronizedScrollTop = viewport?.scrollTop;
    synchronizeIndexed();
  };

  return {
    visibility: { visibleItemIds: () => visibleIds },
    attach: (nextViewport, itemIds): void => {
      layoutOwner?.off("layout-changed", scheduleReflow);
      viewport = nextViewport;
      orderedIds = itemIds;
      itemIndexDirty = true;
      layoutOwner = topmostParent(nextViewport);
      layoutOwner.on("layout-changed", scheduleReflow);
      reflow();
      scheduleReflow();
    },
    detach: (detached): void => {
      if (viewport !== detached) return;
      layoutOwner?.off("layout-changed", scheduleReflow);
      layoutOwner = undefined;
      viewport = undefined;
      orderedIds = [];
      followAlignment = undefined;
      synchronizedScrollTop = undefined;
      clearItemIndex();
      itemIndexDirty = true;
      if (visibleIds === undefined) return;
      visibleIds = undefined;
      for (const listener of listeners) listener();
    },
    reflow,
    synchronize: (): void => {
      if (
        viewport !== undefined &&
        synchronizedScrollTop !== undefined &&
        viewport.scrollTop !== synchronizedScrollTop
      ) {
        stopFollowing();
      }
      synchronize();
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => visibleIds,
    scrollBy: (cells): void => {
      const previousScrollTop = viewport?.scrollTop;
      viewport?.scrollBy(cells);
      if (viewport?.scrollTop !== previousScrollTop) stopFollowing();
      synchronize();
    },
    scrollPage: (direction): void => {
      const previousScrollTop = viewport?.scrollTop;
      const page = Math.max(1, (viewport?.viewport.height ?? 1) - 1);
      viewport?.scrollBy(direction * page);
      if (viewport?.scrollTop !== previousScrollTop) stopFollowing();
      synchronize();
    },
    follow: (itemId): void => {
      if (itemId !== followedId) followAlignment = undefined;
      followedId = itemId;
      if (itemId === undefined) return;
      ensureItemIndex();
      revealFollowedItemIndexed();
      synchronizedScrollTop = viewport?.scrollTop;
      synchronizeIndexed();
    },
  };
}

function topmostParent(renderable: BaseRenderable): BaseRenderable {
  let current = renderable;
  while (current.parent !== null) current = current.parent;
  return current;
}

function geometry<ItemId extends string>(
  id: ItemId,
  item: Renderable,
): SemanticItemGeometry<ItemId> {
  return { id, top: item.y, bottom: item.y + item.height };
}

function sameIds<ItemId extends string>(
  left: readonly ItemId[] | undefined,
  right: readonly ItemId[],
): boolean {
  return left !== undefined &&
    left.length === right.length &&
    left.every((id, index) => id === right[index]);
}

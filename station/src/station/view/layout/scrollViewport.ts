import type { BaseRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { DashboardVisibleRowsSource } from "@station/dashboard-core/runtime";
import type { DashboardRowId } from "@station/dashboard-core/selectors";

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
 * Callers can scroll/follow identities but cannot make feature decisions from coordinates.
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
  let reflowQueued = false;
  const listeners = new Set<() => void>();

  const geometryFor = (id: ItemId): SemanticItemGeometry<ItemId> | undefined => {
    const item = viewport?.content.findDescendantById(semanticItemRenderableId(id));
    return item === undefined ? undefined : geometry(id, item);
  };
  const synchronize = (): void => {
    if (viewport === undefined || viewport.viewport.height <= 0) return;
    const next = intersectingSemanticItems(
      {
        top: viewport.viewport.y,
        bottom: viewport.viewport.y + viewport.viewport.height,
      },
      orderedIds.flatMap((id) => {
        const item = geometryFor(id);
        return item === undefined ? [] : [item];
      }),
    );
    if (sameIds(visibleIds, next)) return;
    visibleIds = next;
    for (const listener of listeners) listener();
  };
  const revealFollowedItem = (): void => {
    if (viewport === undefined || followedId === undefined) return;
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
    revealFollowedItem();
    synchronize();
  };
  const scheduleReflow = (): void => {
    if (reflowQueued) return;
    reflowQueued = true;
    queueMicrotask(() => {
      reflowQueued = false;
      reflow();
    });
  };

  return {
    visibility: { visibleItemIds: () => visibleIds },
    attach: (nextViewport, itemIds): void => {
      layoutOwner?.off("layout-changed", scheduleReflow);
      viewport = nextViewport;
      orderedIds = itemIds;
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
      if (visibleIds === undefined) return;
      visibleIds = undefined;
      for (const listener of listeners) listener();
    },
    reflow,
    synchronize: (): void => {
      followAlignment = undefined;
      synchronize();
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => visibleIds,
    scrollBy: (cells): void => {
      followAlignment = undefined;
      viewport?.scrollBy(cells);
      synchronize();
    },
    scrollPage: (direction): void => {
      followAlignment = undefined;
      const page = Math.max(1, (viewport?.viewport.height ?? 1) - 1);
      viewport?.scrollBy(direction * page);
      synchronize();
    },
    follow: (itemId): void => {
      if (itemId !== followedId) followAlignment = undefined;
      followedId = itemId;
      if (itemId === undefined) return;
      revealFollowedItem();
      synchronize();
    },
  };
}

export type DashboardScrollController = ScrollViewportController<DashboardRowId> & {
  readonly visibleRows: DashboardVisibleRowsSource;
};

export function createDashboardScrollController(): DashboardScrollController {
  const controller = createScrollViewportController<DashboardRowId>();
  return {
    ...controller,
    visibleRows: { visibleRowIds: controller.visibility.visibleItemIds },
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

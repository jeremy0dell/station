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

export function semanticItemRenderableId(id: string): string {
  return `station-semantic-item:${id}`;
}

export type ScrollViewportController<ItemId extends string> = {
  readonly visibility: { visibleItemIds(): readonly ItemId[] | undefined };
  setCoordinateRoot(root: Renderable | undefined): void;
  attach(viewport: ScrollBoxRenderable, itemIds: readonly ItemId[]): void;
  detach(viewport: ScrollBoxRenderable): void;
  reflow(): void;
  synchronize(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): readonly ItemId[] | undefined;
  scrollBy(cells: number): void;
  scrollPage(direction: -1 | 1): void;
  follow(itemId: ItemId | undefined): void;
  itemTop(itemId: ItemId): number | undefined;
};

/**
 * Owns the unavoidable translation between semantic identities and OpenTUI cell geometry.
 * Callers can scroll/follow identities but cannot make feature decisions from coordinates.
 */
export function createScrollViewportController<
  ItemId extends string,
>(): ScrollViewportController<ItemId> {
  let viewport: ScrollBoxRenderable | undefined;
  let coordinateRoot: Renderable | undefined;
  let layoutOwner: BaseRenderable | undefined;
  let orderedIds: readonly ItemId[] = [];
  let visibleIds: readonly ItemId[] | undefined;
  let followedId: ItemId | undefined;
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
    if (item.bottom > viewportTop && item.top < viewportBottom) return;
    viewport.scrollChildIntoView(semanticItemRenderableId(followedId));
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
    setCoordinateRoot: (root): void => {
      coordinateRoot = root;
    },
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
      if (visibleIds === undefined) return;
      visibleIds = undefined;
      for (const listener of listeners) listener();
    },
    reflow,
    synchronize,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => visibleIds,
    scrollBy: (cells): void => {
      viewport?.scrollBy(cells);
      synchronize();
    },
    scrollPage: (direction): void => {
      const page = Math.max(1, (viewport?.viewport.height ?? 1) - 1);
      viewport?.scrollBy(direction * page);
      synchronize();
    },
    follow: (itemId): void => {
      followedId = itemId;
      if (itemId === undefined) return;
      viewport?.scrollChildIntoView(semanticItemRenderableId(itemId));
      synchronize();
    },
    itemTop: (itemId): number | undefined => {
      const item = geometryFor(itemId);
      return item === undefined || viewport === undefined
        ? undefined
        : item.top - (coordinateRoot?.y ?? viewport.y);
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

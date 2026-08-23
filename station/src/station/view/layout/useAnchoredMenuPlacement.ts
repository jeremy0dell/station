import {
  type BaseRenderable,
  type BoxRenderable,
  Renderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

export type AnchoredMenuPlacement = {
  readonly top: number;
  readonly maxHeight: number;
};

export function anchoredMenuPlacement(
  boundary: { readonly top: number; readonly height: number },
  anchor: { readonly top: number; readonly height: number },
  intrinsicHeight: number,
): AnchoredMenuPlacement {
  const maxHeight = Math.max(1, Math.min(intrinsicHeight, boundary.height));
  const boundaryBottom = boundary.top + boundary.height;
  const below = anchor.top + anchor.height;
  return {
    top:
      below + maxHeight <= boundaryBottom
        ? below
        : Math.max(boundary.top, anchor.top - maxHeight),
    maxHeight,
  };
}

/** Places a semantic menu from measured OpenTUI anchor/content boxes and keeps it in its owner. */
export function useAnchoredMenuPlacement(
  boundaryId: string,
  anchorRenderableId: string,
  contentViewportId: string,
): RefObject<BoxRenderable | null> {
  const menuRef = useRef<BoxRenderable>(null);
  const controller = useMemo(
    () =>
      anchoredMenuPlacementController(
        boundaryId,
        anchorRenderableId,
        contentViewportId,
      ),
    [anchorRenderableId, boundaryId, contentViewportId],
  );
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    controller.attach(menu);
    return () => controller.detach(menu);
  }, [controller]);
  return menuRef;
}

function anchoredMenuPlacementController(
  boundaryId: string,
  anchorRenderableId: string,
  contentViewportId: string,
): {
  attach(menu: BoxRenderable): void;
  detach(menu: BoxRenderable): void;
} {
  let menu: BoxRenderable | undefined;
  let layoutOwner: BaseRenderable | undefined;
  let intrinsicHeight = 0;
  let appliedTop: number | undefined;
  let appliedMaxHeight: number | undefined;
  let queued = false;
  let active = false;

  const reflow = (): void => {
    queued = false;
    if (!active || menu === undefined) return;
    const boundary = ancestorRenderable(menu, boundaryId);
    if (boundary === undefined) return;
    const anchor = boundary.findDescendantById(anchorRenderableId);
    if (!(anchor instanceof Renderable)) return;
    const contentViewport = menu.findDescendantById(contentViewportId);
    if (contentViewport instanceof ScrollBoxRenderable) {
      const decorationHeight = Math.max(0, menu.height - contentViewport.viewport.height);
      intrinsicHeight = Math.max(
        intrinsicHeight,
        contentViewport.scrollHeight + decorationHeight,
      );
    } else {
      intrinsicHeight = Math.max(intrinsicHeight, menu.height);
    }
    const placement = anchoredMenuPlacement(
      { top: boundary.y, height: boundary.height },
      { top: anchor.y, height: anchor.height },
      intrinsicHeight,
    );
    const localTop = placement.top - boundary.y;
    if (localTop !== appliedTop) {
      appliedTop = localTop;
      menu.top = localTop;
    }
    if (placement.maxHeight !== appliedMaxHeight) {
      appliedMaxHeight = placement.maxHeight;
      menu.maxHeight = placement.maxHeight;
      menu.height = placement.maxHeight;
    }
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(reflow);
  };

  return {
    attach(nextMenu): void {
      menu = nextMenu;
      active = true;
      layoutOwner = topmostParent(nextMenu);
      layoutOwner.on("layout-changed", schedule);
      schedule();
    },
    detach(detached): void {
      if (menu !== detached) return;
      active = false;
      layoutOwner?.off("layout-changed", schedule);
      layoutOwner = undefined;
      menu = undefined;
      intrinsicHeight = 0;
      appliedTop = undefined;
      appliedMaxHeight = undefined;
    },
  };
}

function ancestorRenderable(renderable: BaseRenderable, id: string): Renderable | undefined {
  let current = renderable.parent;
  while (current !== null) {
    if (current.id === id && current instanceof Renderable) return current;
    current = current.parent;
  }
  return undefined;
}

function topmostParent(renderable: BaseRenderable): BaseRenderable {
  let current = renderable;
  while (current.parent !== null) current = current.parent;
  return current;
}

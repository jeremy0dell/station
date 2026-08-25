import {
  type BaseRenderable,
  type BoxRenderable,
  Renderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { measuredVerticalInsets } from "../station/view/layout/renderBoxInsets.js";
import { placeContextMenu } from "./placement.js";
import type { ContextMenuAnchor } from "./types.js";

/** Resolves an inherently physical pointer anchor against measured OpenTUI menu geometry. */
export function usePointerAnchoredMenuPlacement({
  boundaryId,
  anchor,
  contentViewportId,
  preferredWidth,
}: {
  boundaryId: string;
  anchor: ContextMenuAnchor;
  contentViewportId: string;
  preferredWidth: number;
}): RefObject<BoxRenderable | null> {
  const menuRef = useRef<BoxRenderable>(null);
  const { x: anchorX, y: anchorY } = anchor;
  const controller = useMemo(
    () =>
      pointerAnchoredMenuController({
        boundaryId,
        anchor: { x: anchorX, y: anchorY },
        contentViewportId,
        preferredWidth,
      }),
    [anchorX, anchorY, boundaryId, contentViewportId, preferredWidth],
  );
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    controller.attach(menu);
    return () => controller.detach(menu);
  }, [controller]);
  return menuRef;
}

function pointerAnchoredMenuController({
  boundaryId,
  anchor,
  contentViewportId,
  preferredWidth,
}: {
  boundaryId: string;
  anchor: ContextMenuAnchor;
  contentViewportId: string;
  preferredWidth: number;
}): {
  attach(menu: BoxRenderable): void;
  detach(menu: BoxRenderable): void;
} {
  let menu: BoxRenderable | undefined;
  let layoutOwner: BaseRenderable | undefined;
  let applied: { left: number; top: number; width: number; height: number } | undefined;
  let queued = false;
  let active = false;

  const reflow = (): void => {
    queued = false;
    if (!active || menu === undefined) return;
    const boundary = ancestorRenderable(menu, boundaryId);
    if (boundary === undefined) return;
    const contentViewport = menu.findDescendantById(contentViewportId);
    if (!(contentViewport instanceof ScrollBoxRenderable)) return;
    const intrinsicHeight = contentViewport.scrollHeight + measuredVerticalInsets(menu);
    const placement = placeContextMenu(
      { x: anchor.x - boundary.x, y: anchor.y - boundary.y },
      { width: preferredWidth, height: intrinsicHeight },
      { width: boundary.width, height: boundary.height },
    );
    if (samePlacement(applied, placement)) return;
    applied = placement;
    menu.left = placement.left;
    menu.top = placement.top;
    menu.maxWidth = placement.width;
    menu.maxHeight = placement.height;
    menu.width = placement.width;
    menu.height = placement.height;
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
      applied = undefined;
    },
  };
}

function samePlacement(
  left: { left: number; top: number; width: number; height: number } | undefined,
  right: { left: number; top: number; width: number; height: number },
): boolean {
  return (
    left !== undefined &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
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

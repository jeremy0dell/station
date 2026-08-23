import { type BaseRenderable, type BoxRenderable, Renderable } from "@opentui/core";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

export function availableHeightWithin(
  boundary: { readonly top: number; readonly height: number },
  overlay: { readonly top: number },
): number {
  return Math.max(1, boundary.top + boundary.height - overlay.top);
}

/**
 * OpenTUI boundary that clips an anchored overlay to a structural ancestor's measured box.
 * Semantic content stays complete; only the renderer sees terminal-cell coordinates.
 */
export function useAncestorBoundedHeight(boundaryId: string): RefObject<BoxRenderable | null> {
  const overlayRef = useRef<BoxRenderable>(null);
  const controller = useMemo(() => ancestorBoundedHeightController(boundaryId), [boundaryId]);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    controller.attach(overlay);
    return () => controller.detach(overlay);
  }, [controller]);
  return overlayRef;
}

function ancestorBoundedHeightController(boundaryId: string): {
  attach(overlay: BoxRenderable): void;
  detach(overlay: BoxRenderable): void;
} {
  let overlay: BoxRenderable | undefined;
  let layoutOwner: BaseRenderable | undefined;
  let appliedHeight: number | undefined;
  let queued = false;
  let active = false;

  const reflow = (): void => {
    queued = false;
    if (!active || overlay === undefined) return;
    const boundary = ancestorRenderable(overlay, boundaryId);
    if (boundary === undefined) return;
    const nextHeight = availableHeightWithin(
      { top: boundary.y, height: boundary.height },
      { top: overlay.y },
    );
    if (nextHeight === appliedHeight) return;
    appliedHeight = nextHeight;
    overlay.maxHeight = nextHeight;
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(reflow);
  };

  return {
    attach(nextOverlay): void {
      overlay = nextOverlay;
      active = true;
      layoutOwner = topmostParent(nextOverlay);
      layoutOwner.on("layout-changed", schedule);
      schedule();
    },
    detach(detached): void {
      if (overlay !== detached) return;
      active = false;
      layoutOwner?.off("layout-changed", schedule);
      layoutOwner = undefined;
      overlay = undefined;
      appliedHeight = undefined;
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

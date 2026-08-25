import {
  type BaseRenderable,
  type BoxRenderable,
  Renderable,
  ScrollBoxRenderable,
  Yoga,
} from "@opentui/core";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { measuredVerticalInsets } from "./renderBoxInsets.js";

export function availableHeightWithin(
  boundary: { readonly top: number; readonly height: number },
  overlay: { readonly top: number },
): number {
  return Math.max(1, boundary.top + boundary.height - overlay.top);
}

export function boundedIntrinsicOverlayLayout({
  availableHeight,
  decorationHeight,
  contentHeight,
}: {
  availableHeight: number;
  decorationHeight: number;
  contentHeight: number;
}): { readonly overlayHeight: number; readonly viewportHeight: number } {
  const overlayHeight = Math.max(
    1,
    Math.min(availableHeight, contentHeight + decorationHeight),
  );
  return {
    overlayHeight,
    viewportHeight: Math.max(1, overlayHeight - decorationHeight),
  };
}

/**
 * OpenTUI boundary that clips an anchored overlay to a structural ancestor's measured box.
 * Semantic content stays complete; only the renderer sees terminal-cell coordinates.
 */
export function useAncestorBoundedHeight(
  boundaryId: string,
  contentViewportId: string,
  contentIdentity: string,
): RefObject<BoxRenderable | null> {
  const overlayRef = useRef<BoxRenderable>(null);
  const controller = useMemo(
    () => ancestorBoundedHeightController(boundaryId, contentViewportId, contentIdentity),
    [boundaryId, contentIdentity, contentViewportId],
  );
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    controller.attach(overlay);
    return () => controller.detach(overlay);
  }, [controller]);
  return overlayRef;
}

function ancestorBoundedHeightController(
  boundaryId: string,
  contentViewportId: string,
  _contentIdentity: string,
): {
  attach(overlay: BoxRenderable): void;
  detach(overlay: BoxRenderable): void;
} {
  let overlay: BoxRenderable | undefined;
  let layoutOwner: BaseRenderable | undefined;
  let appliedLayout:
    | { readonly overlayHeight: number; readonly viewportHeight: number }
    | undefined;
  let queued = false;
  let active = false;

  const reflow = (): void => {
    queued = false;
    if (!active || overlay === undefined) return;
    const boundary = ancestorRenderable(overlay, boundaryId);
    if (boundary === undefined) return;
    const contentViewport = overlay.findDescendantById(contentViewportId);
    if (!(contentViewport instanceof ScrollBoxRenderable)) return;
    if (overlay.height <= 0) return;
    const availableHeight = availableHeightWithin(
      { top: boundary.y, height: boundary.height },
      { top: overlay.y },
    );
    const nextLayout = boundedIntrinsicOverlayLayout({
      availableHeight,
      decorationHeight: laidOutDecorationHeight(overlay, contentViewport),
      contentHeight: laidOutContentHeight(contentViewport),
    });
    if (
      nextLayout.overlayHeight === appliedLayout?.overlayHeight &&
      nextLayout.viewportHeight === appliedLayout.viewportHeight
    ) {
      return;
    }
    appliedLayout = nextLayout;
    // Definite measured sizes make flex allocation deterministic across OpenTUI
    // platforms; the viewport absorbs clipping while actions stay in the structure.
    contentViewport.maxHeight = nextLayout.viewportHeight;
    contentViewport.height = nextLayout.viewportHeight;
    overlay.maxHeight = nextLayout.overlayHeight;
    overlay.height = nextLayout.overlayHeight;
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
      // A semantic stage change must discard the previous stage's definite size
      // before measuring the replacement's complete intrinsic scroll content.
      overlay.height = "auto";
      overlay.maxHeight = undefined;
      const contentViewport = overlay.findDescendantById(contentViewportId);
      if (contentViewport instanceof ScrollBoxRenderable) {
        contentViewport.height = "auto";
        contentViewport.maxHeight = undefined;
      }
      layoutOwner = topmostParent(nextOverlay);
      layoutOwner.on("layout-changed", schedule);
      // Measure only after OpenTUI has laid out the intrinsic replacement; the
      // pre-layout geometry still belongs to the prior semantic stage.
      nextOverlay.requestRender();
    },
    detach(detached): void {
      if (overlay !== detached) return;
      active = false;
      layoutOwner?.off("layout-changed", schedule);
      layoutOwner = undefined;
      overlay = undefined;
      appliedLayout = undefined;
    },
  };
}

function laidOutDecorationHeight(
  overlay: BoxRenderable,
  contentViewport: ScrollBoxRenderable,
): number {
  return (
    measuredVerticalInsets(overlay) +
    overlay.getChildren().reduce((height, child) => {
      if (child === contentViewport) return height;
      const layout = child.getLayoutNode();
      return (
        height +
        child.height +
        layout.getComputedMargin(Yoga.Edge.Top) +
        layout.getComputedMargin(Yoga.Edge.Bottom)
      );
    }, 0)
  );
}

function laidOutContentHeight(viewport: ScrollBoxRenderable): number {
  // ScrollBox scrollHeight is never smaller than its viewport. Child extents retain
  // the intrinsic size needed to distinguish compact content from spare flex space.
  return Math.max(
    1,
    ...viewport.content
      .getChildren()
      .map((child) => child.y + child.height - viewport.content.y),
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

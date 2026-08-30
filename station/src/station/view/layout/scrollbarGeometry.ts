export type ScrollbarThumbGeometryInput = {
  readonly trackHeight: number;
  readonly contentHeight: number;
  readonly viewportHeight: number;
  readonly scrollPosition: number;
};

export type ScrollbarThumbGeometry = {
  readonly trackHeight: number;
  readonly thumbTop: number;
  readonly thumbHeight: number;
  readonly overflow: boolean;
};

/** Maps scroll content coordinates to a stable whole-cell scrollbar thumb. */
export function scrollbarThumbGeometry({
  trackHeight: rawTrackHeight,
  contentHeight: rawContentHeight,
  viewportHeight: rawViewportHeight,
  scrollPosition,
}: ScrollbarThumbGeometryInput): ScrollbarThumbGeometry {
  const trackHeight = Math.max(0, Math.floor(rawTrackHeight));
  const contentHeight = Math.max(0, Math.floor(rawContentHeight));
  const viewportHeight = Math.max(1, Math.floor(rawViewportHeight));
  const overflow = contentHeight > viewportHeight && trackHeight > 0;
  // A whole-cell thumb keeps the same painted height at every scroll position.
  const thumbHeight = overflow
    ? Math.min(
        trackHeight,
        Math.max(1, Math.round((viewportHeight * trackHeight) / contentHeight)),
      )
    : 0;
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const maxOffset = Math.max(1, contentHeight - viewportHeight);
  const offset = Math.min(Math.max(0, Math.floor(scrollPosition)), maxOffset);
  const thumbTop = Math.round((offset * maxThumbTop) / maxOffset);

  return { trackHeight, thumbTop, thumbHeight, overflow };
}

/** Returns a scroll offset only when a pointer lands on the first or last track cell. */
export function scrollbarTrackEndpoint({
  localY,
  trackHeight,
  contentHeight,
  viewportHeight,
}: {
  readonly localY: number;
  readonly trackHeight: number;
  readonly contentHeight: number;
  readonly viewportHeight: number;
}): number | undefined {
  if (trackHeight <= 1) return undefined;
  if (localY <= 0) return 0;
  if (localY >= trackHeight - 1) {
    return Math.max(0, contentHeight - viewportHeight);
  }
  return undefined;
}

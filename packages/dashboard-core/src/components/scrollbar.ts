export const VERTICAL_SCROLLBAR_THUMB = "▐";
/** Thin right rail for leftover track; same cell as the thumb, not a second column. */
export const VERTICAL_SCROLLBAR_TRACK = "▕";
export const VERTICAL_SCROLLBAR_EMPTY = " ";

export type VerticalScrollbarInput = {
  trackHeight: number;
  contentLength: number;
  viewportLength: number;
  offset: number;
};

/** Whole-cell thumb. Hidden when content fits. Overflowing leftover cells keep a rail. */
export function verticalScrollbarCells(input: VerticalScrollbarInput): string[] {
  const trackHeight = Math.max(0, Math.floor(input.trackHeight));
  const metrics = scrollbarThumbMetrics(input, trackHeight);
  if (metrics === undefined) {
    return Array.from({ length: trackHeight }, () => VERTICAL_SCROLLBAR_EMPTY);
  }
  const { thumbStart, thumbSize } = metrics;
  const cells = Array.from({ length: trackHeight }, () => VERTICAL_SCROLLBAR_TRACK);
  for (let index = thumbStart; index < thumbStart + thumbSize; index += 1) {
    cells[index] = VERTICAL_SCROLLBAR_THUMB;
  }
  return cells;
}

/** Maps a track cell to a clamped content offset for click-to-scroll. */
export function scrollbarOffsetForTrackIndex(
  input: VerticalScrollbarInput & { trackIndex: number },
): number {
  const trackHeight = Math.max(0, Math.floor(input.trackHeight));
  const contentLength = Math.max(0, Math.floor(input.contentLength));
  const viewportLength = Math.max(1, Math.floor(input.viewportLength));
  const maxOffset = Math.max(0, contentLength - viewportLength);
  if (maxOffset === 0 || trackHeight <= 1) {
    return 0;
  }
  const trackIndex = Math.min(Math.max(0, Math.floor(input.trackIndex)), trackHeight - 1);
  return Math.round((trackIndex * maxOffset) / (trackHeight - 1));
}

function scrollbarThumbMetrics(
  input: VerticalScrollbarInput,
  trackHeight: number,
): { thumbStart: number; thumbSize: number } | undefined {
  const contentLength = Math.max(0, Math.floor(input.contentLength));
  const viewportLength = Math.max(1, Math.floor(input.viewportLength));
  if (trackHeight === 0 || contentLength <= viewportLength) {
    return undefined;
  }
  // Blink cc::ScrollUtils::CalculateScrollbarThumbLength (WebKit Composite
  // matches the round + min). Min is one cell = bar thickness. Firefox sizes
  // from page-increment instead of visible/content; do not copy that.
  const thumbSize = Math.min(
    trackHeight,
    Math.max(1, Math.round((viewportLength * trackHeight) / contentLength)),
  );
  const maxThumbStart = Math.max(0, trackHeight - thumbSize);
  const maxOffset = Math.max(1, contentLength - viewportLength);
  const offset = Math.min(Math.max(0, Math.floor(input.offset)), contentLength - viewportLength);
  const thumbStart = Math.round((offset * maxThumbStart) / maxOffset);
  return { thumbStart, thumbSize };
}

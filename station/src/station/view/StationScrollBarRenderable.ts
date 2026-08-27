// Driven OpenTUI scrollbar painter. Station still owns windowing, keys, and
// scroll offsets; this class must not take focus or handle j/k/arrows.
import {
  ScrollBarRenderable,
  type KeyEvent,
  type MouseEvent,
  type RenderContext,
  type ScrollBarOptions,
} from "@opentui/core";
import { extend } from "@opentui/react";

export type StationScrollBarOptions = ScrollBarOptions & {
  onPositionChange?: (position: number) => void;
  scrollSize?: number;
  viewportSize?: number;
  scrollPosition?: number;
};

export class StationScrollBarRenderable extends ScrollBarRenderable {
  onPositionChange: ((position: number) => void) | undefined;

  constructor(ctx: RenderContext, options: StationScrollBarOptions) {
    const { onPositionChange, scrollSize, viewportSize, scrollPosition, ...scrollBarOptions } =
      options;
    super(ctx, {
      ...scrollBarOptions,
      showArrows: scrollBarOptions.showArrows ?? false,
      onChange: (position) => {
        this.onPositionChange?.(Math.round(position));
      },
    });
    this.focusable = false;
    this.onPositionChange = onPositionChange;
    if (scrollSize !== undefined) {
      this.scrollSize = scrollSize;
    }
    if (viewportSize !== undefined) {
      this.viewportSize = viewportSize;
    }
    if (scrollPosition !== undefined) {
      this.scrollPosition = scrollPosition;
    }
    this.bindTrackEndSnaps();
  }

  handleKeyPress(_key: KeyEvent): boolean {
    return false;
  }

  /**
   * OpenTUI maps cell y through `y/height` and `y*2` virtual units, so a pointer
   * on the last cell cannot reach maxOffset when maxOffset is large. Wrap the
   * slider's mouse value writers (onMouseDown has no getter) and assign the snap
   * instead of the exclusive-end write so the store never sees the near-max lie.
   * isDragging still lives in the original onMouseDown/Up closures.
   */
  private bindTrackEndSnaps(): void {
    const slider = this.slider as typeof this.slider & SliderMouseHost;
    const originalDirect = slider.updateValueFromMouseDirect.bind(slider);
    const originalOffset = slider.updateValueFromMouseWithOffset.bind(slider);
    slider.updateValueFromMouseDirect = (event) => {
      this.applyMouseValue(event, () => originalDirect(event));
    };
    slider.updateValueFromMouseWithOffset = (event, offsetVirtual) => {
      this.applyMouseValue(event, () => originalOffset(event, offsetVirtual));
    };
  }

  private applyMouseValue(event: { y: number }, applyOriginal: () => void): void {
    const snapped = this.offsetForTrackPointer(event);
    if (snapped !== undefined) {
      this.scrollPosition = snapped;
      return;
    }
    applyOriginal();
  }

  private offsetForTrackPointer(event: { y: number }): number | undefined {
    const trackHeight = this.slider.height;
    if (trackHeight <= 1) {
      return undefined;
    }
    const maxOffset = Math.max(0, this.scrollSize - this.viewportSize);
    const localY = event.y - this.slider.y;
    if (localY <= 0) {
      return 0;
    }
    if (localY >= trackHeight - 1) {
      return maxOffset;
    }
    return undefined;
  }
}

type SliderMouseHost = {
  updateValueFromMouseDirect: (event: MouseEvent) => void;
  updateValueFromMouseWithOffset: (event: MouseEvent, offsetVirtual: number) => void;
};

extend({ stationScrollBar: StationScrollBarRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    stationScrollBar: typeof StationScrollBarRenderable;
  }
}

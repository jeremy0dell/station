// Driven OpenTUI scrollbar painter. Station still owns windowing, keys, and
// scroll offsets; this class must not take focus or handle j/k/arrows.
import {
  ScrollBarRenderable,
  type KeyEvent,
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
  }

  handleKeyPress(_key: KeyEvent): boolean {
    return false;
  }
}

extend({ stationScrollBar: StationScrollBarRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    stationScrollBar: typeof StationScrollBarRenderable;
  }
}

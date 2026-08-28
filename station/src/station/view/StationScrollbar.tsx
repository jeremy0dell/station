import {
  parseColor,
  type MouseEvent,
  type OptimizedBuffer,
  ScrollBarRenderable,
  type ScrollBarOptions,
  type SliderRenderable,
} from "@opentui/core";
import { extend } from "@opentui/react";
import { useLayoutEffect, useRef } from "react";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import {
  stationScrollbarPointerProps,
  useStationHoverEnabled,
  useStationMouse,
} from "./stationMouseContext.js";

extend({ stationScrollbar: ScrollBarRenderable });

declare module "@opentui/react" {
  interface OpenTUIComponents {
    stationScrollbar: typeof ScrollBarRenderable;
  }
}

export function StationScrollbar({
  surface,
  contentLength,
  viewportLength,
  trackHeight,
  offset,
}: {
  surface: "help" | "dashboard";
  contentLength: number;
  viewportLength: number;
  trackHeight: number;
  offset: number;
}) {
  const theme = useStationTheme();
  const hoverEnabled = useStationHoverEnabled();
  const dispatch = useStationMouse();
  const ref = useRef<ScrollBarRenderable>(null);
  const inputRef = useRef({ surface, contentLength, viewportLength, trackHeight });
  inputRef.current = { surface, contentLength, viewportLength, trackHeight };
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const hoverRef = useRef(false);
  const draggingRef = useRef(false);
  const themeRef = useRef(theme);
  const hoverEnabledRef = useRef(hoverEnabled);
  themeRef.current = theme;
  hoverEnabledRef.current = hoverEnabled;

  useLayoutEffect(() => {
    const scrollbar = ref.current;
    if (scrollbar === null) return;
    scrollbar.scrollSize = Math.max(0, Math.floor(contentLength));
    scrollbar.viewportSize = Math.max(1, Math.floor(viewportLength));
    scrollbar.scrollPosition = Math.max(0, Math.floor(offset));
    scrollbar.requestRender();
  }, [contentLength, offset, viewportLength]);

  const options: Omit<ScrollBarOptions, "orientation"> = {
    width: 1,
    height: Math.max(0, Math.floor(trackHeight)),
    showArrows: false,
    trackOptions: {
      width: 1,
      backgroundColor: "transparent",
      foregroundColor: "transparent",
      onMouse(event) {
        const interactionChanged = updateScrollbarInteraction(event);
        if (interactionChanged) this.requestRender();

        const pointer = stationScrollbarPointerProps(dispatchRef.current, {
          ...inputRef.current,
          trackTop: () => ref.current?.slider.y ?? 0,
        });
        if (event.type === "down") pointer.onMouseDown(event);
        if (event.type === "drag") pointer.onMouseDrag(event);
        if (event.type === "scroll") pointer.onMouseScroll(event);
      },
      renderAfter(buffer) {
        paintStationScrollbar(
          this,
          buffer,
          themeRef.current,
          hoverEnabledRef.current,
          hoverRef.current,
          draggingRef.current,
        );
      },
    },
  };

  return <stationScrollbar ref={ref} orientation="vertical" {...options} />;

  function updateScrollbarInteraction(event: MouseEvent): boolean {
    const wasHovered = hoverRef.current;
    const wasDragging = draggingRef.current;
    switch (event.type) {
      case "over":
        hoverRef.current = true;
        break;
      case "out":
        hoverRef.current = false;
        draggingRef.current = false;
        break;
      case "down":
      case "drag":
        draggingRef.current = true;
        break;
      case "up":
      case "drag-end":
        draggingRef.current = false;
        break;
    }
    return wasHovered !== hoverRef.current || wasDragging !== draggingRef.current;
  }
}

function paintStationScrollbar(
  slider: SliderRenderable,
  buffer: OptimizedBuffer,
  theme: ReturnType<typeof useStationTheme>,
  hoverEnabled: boolean,
  hovered: boolean,
  dragging: boolean,
): void {
  const scrollbar = slider.parent as ScrollBarRenderable;
  const trackHeight = Math.max(0, Math.floor(slider.height));
  const contentLength = Math.max(0, Math.floor(scrollbar.scrollSize));
  const viewportLength = Math.max(1, Math.floor(scrollbar.viewportSize));
  const overflow = contentLength > viewportLength && trackHeight > 0;
  const thumbSize = overflow
    ? Math.min(trackHeight, Math.max(1, Math.round((viewportLength * trackHeight) / contentLength)))
    : 0;
  const maxThumbStart = Math.max(0, trackHeight - thumbSize);
  const maxOffset = Math.max(1, contentLength - viewportLength);
  const offset = Math.min(Math.max(0, Math.floor(scrollbar.scrollPosition)), maxOffset);
  const thumbStart = Math.round((offset * maxThumbStart) / maxOffset);
  const active = overflow && (dragging || (hoverEnabled && hovered));
  const foreground = parseColor(toOpenTuiColor(active ? theme.text.primary : theme.text.muted));
  const background = dragging && overflow
    ? parseColor(toOpenTuiColor(theme.interaction.hover))
    : slider.backgroundColor;

  for (let index = 0; index < trackHeight; index += 1) {
    const glyph = !overflow
      ? " "
      : index >= thumbStart && index < thumbStart + thumbSize
        ? "▐"
        : "▕";
    buffer.setCellWithAlphaBlending(slider.x, slider.y + index, glyph, foreground, background);
  }
}

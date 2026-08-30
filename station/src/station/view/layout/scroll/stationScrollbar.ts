import type {
  MouseEvent,
  OptimizedBuffer,
  ScrollBarOptions,
  ScrollBarRenderable,
  SliderRenderable,
} from "@opentui/core";
import { toOpenTuiColor, type StationTheme } from "../../../../theme/index.js";
import {
  scrollbarThumbGeometry,
  scrollbarTrackEndpoint,
} from "./scrollbarGeometry.js";

export function stationScrollbarOptions(
  theme: StationTheme,
  hoverEnabled: boolean,
  placement: "inside" | "gutter",
  synchronize: () => void,
): Omit<ScrollBarOptions, "orientation"> {
  const restingColor = toOpenTuiColor(theme.text.muted);
  const hoverColor = toOpenTuiColor(theme.text.primary);
  return {
    width: 1,
    height: "100%",
    position: "absolute",
    top: 0,
    right: placement === "gutter" ? -1 : 0,
    showArrows: true,
    arrowOptions: {
      foregroundColor: restingColor,
      backgroundColor: "transparent",
      onMouse(event) {
        if (event.type === "over") {
          this.foregroundColor = hoverEnabled ? hoverColor : restingColor;
        } else if (event.type === "out") {
          this.foregroundColor = restingColor;
        }
        synchronizeAfterScrollbarMouse(event, synchronize);
      },
    },
    trackOptions: {
      width: 1,
      backgroundColor: "transparent",
      foregroundColor: restingColor,
      renderAfter(buffer) {
        paintStationScrollbar(this, buffer);
      },
      onMouse(event) {
        switch (event.type) {
          case "over":
            this.foregroundColor = hoverEnabled ? hoverColor : restingColor;
            break;
          case "out":
            this.foregroundColor = restingColor;
            this.backgroundColor = "transparent";
            break;
          case "down":
          case "drag":
            this.backgroundColor = toOpenTuiColor(theme.interaction.hover);
            break;
          case "up":
          case "drag-end":
            this.backgroundColor = "transparent";
            break;
        }
        snapScrollbarTrackEnd(this, event);
        synchronizeAfterScrollbarMouse(event, synchronize);
      },
    },
  };
}

function synchronizeAfterScrollbarMouse(event: MouseEvent, synchronize: () => void): void {
  if (
    event.type === "down" ||
    event.type === "drag" ||
    event.type === "up" ||
    event.type === "drag-end"
  ) {
    queueMicrotask(synchronize);
  }
}

function paintStationScrollbar(slider: SliderRenderable, buffer: OptimizedBuffer): void {
  const scrollbar = slider.parent as ScrollBarRenderable;
  const geometry = scrollbarThumbGeometry({
    trackHeight: slider.height,
    contentHeight: scrollbar.scrollSize,
    viewportHeight: scrollbar.viewportSize,
    scrollPosition: scrollbar.scrollPosition,
  });

  for (let row = 0; row < geometry.trackHeight; row += 1) {
    const glyph = geometry.overflow &&
        row >= geometry.thumbTop &&
        row < geometry.thumbTop + geometry.thumbHeight
      ? "▐"
      : "▕";
    buffer.setCellWithAlphaBlending(
      slider.x,
      slider.y + row,
      glyph,
      slider.foregroundColor,
      slider.backgroundColor,
    );
  }
}

function snapScrollbarTrackEnd(slider: SliderRenderable, event: MouseEvent): void {
  if (
    event.type !== "down" &&
    event.type !== "drag" &&
    event.type !== "up" &&
    event.type !== "drag-end"
  ) {
    return;
  }
  const scrollbar = slider.parent as ScrollBarRenderable;
  const position = scrollbarTrackEndpoint({
    localY: event.y - slider.y,
    trackHeight: slider.height,
    contentHeight: scrollbar.scrollSize,
    viewportHeight: scrollbar.viewportSize,
  });
  if (position === undefined) return;
  const snap = () => {
    scrollbar.scrollPosition = position;
  };
  if (event.type === "up" || event.type === "drag-end") {
    // OpenTUI writes its exclusive-end mouse ratio after the generic release handler.
    queueMicrotask(snap);
  } else {
    snap();
  }
}

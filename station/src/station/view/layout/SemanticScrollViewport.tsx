import type {
  MouseEvent,
  OptimizedBuffer,
  ScrollBarOptions,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  SliderRenderable,
} from "@opentui/core";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { toOpenTuiColor, type StationTheme, useStationTheme } from "../../../theme/index.js";
import { useStationHoverEnabled } from "../stationMouseContext.js";
import {
  createScrollViewportController,
  type ScrollViewportController,
} from "./scrollViewport.js";

/** Scroll region for overlays whose geometry is wholly renderer-owned. */
export function SemanticScrollRegion<ItemId extends string>({
  itemIds,
  followedItemId,
  children,
  fill = true,
  scrollbar,
  viewportId,
  controller: suppliedController,
}: {
  itemIds: readonly ItemId[];
  followedItemId?: ItemId;
  children: ReactNode;
  fill?: boolean;
  scrollbar?: "inside" | "gutter";
  viewportId?: string;
  controller?: ScrollViewportController<ItemId>;
}) {
  const localController = useMemo(() => createScrollViewportController<ItemId>(), []);
  const controller = suppliedController ?? localController;
  useEffect(() => {
    controller.follow(followedItemId);
    queueMicrotask(controller.reflow);
  }, [controller, followedItemId]);
  return (
    <SemanticScrollViewport
      controller={controller}
      itemIds={itemIds}
      fill={fill}
      {...(scrollbar === undefined ? {} : { scrollbar })}
      viewportId={viewportId}
    >
      {children}
    </SemanticScrollViewport>
  );
}

/** Flex-sized viewport that binds semantic item identities to OpenTUI scroll geometry. */
export function SemanticScrollViewport<ItemId extends string>({
  controller,
  itemIds,
  children,
  fill = true,
  scrollbar,
  viewportId,
}: {
  controller: ScrollViewportController<ItemId>;
  itemIds: readonly ItemId[];
  children: ReactNode;
  /** Fill a definite parent height; intrinsic overlays leave this false and only shrink at max-height. */
  fill?: boolean;
  scrollbar?: "inside" | "gutter";
  viewportId?: string;
}) {
  const theme = useStationTheme();
  const hoverEnabled = useStationHoverEnabled();
  const ref = useRef<ScrollBoxRenderable>(null);
  const verticalScrollbarOptions = useMemo(
    () =>
      scrollbar === undefined
        ? { visible: false }
        : stationScrollbarOptions(theme, hoverEnabled, scrollbar, controller.synchronize),
    [controller, hoverEnabled, scrollbar, theme],
  );
  const itemIdentity = itemIds.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reattach only when semantic identity changes, not when a selector returns a new array.
  useLayoutEffect(() => {
    const viewport = ref.current;
    if (viewport === null) return;
    controller.attach(viewport, itemIds);
    queueMicrotask(controller.reflow);
    return () => controller.detach(viewport);
  }, [controller, itemIdentity]);

  return (
    <scrollbox
      {...(viewportId === undefined ? {} : { id: viewportId })}
      ref={ref}
      width="100%"
      flexGrow={fill ? 1 : 0}
      flexShrink={1}
      {...(fill ? { flexBasis: 0 } : {})}
      minHeight={fill ? 0 : 1}
      scrollX={false}
      scrollY
      viewportCulling
      verticalScrollbarOptions={verticalScrollbarOptions}
      horizontalScrollbarOptions={{ visible: false }}
      contentOptions={{
        flexDirection: "column",
        ...(fill ? {} : { minHeight: "auto" as const }),
      }}
      onSizeChange={() => queueMicrotask(controller.reflow)}
      onMouseScroll={() => queueMicrotask(controller.synchronize)}
    >
      {children}
    </scrollbox>
  );
}

function stationScrollbarOptions(
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
  const trackHeight = Math.max(0, Math.floor(slider.height));
  const contentHeight = Math.max(0, Math.floor(scrollbar.scrollSize));
  const viewportHeight = Math.max(1, Math.floor(scrollbar.viewportSize));
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
  const offset = Math.min(Math.max(0, Math.floor(scrollbar.scrollPosition)), maxOffset);
  const thumbTop = Math.round((offset * maxThumbTop) / maxOffset);

  for (let row = 0; row < trackHeight; row += 1) {
    const glyph = overflow && row >= thumbTop && row < thumbTop + thumbHeight ? "▐" : "▕";
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
  if (slider.height <= 1) {
    return;
  }
  const localY = event.y - slider.y;
  const scrollbar = slider.parent as ScrollBarRenderable;
  let position: number;
  if (localY <= 0) {
    position = 0;
  } else if (localY >= slider.height - 1) {
    position = Math.max(0, scrollbar.scrollSize - scrollbar.viewportSize);
  } else {
    return;
  }
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

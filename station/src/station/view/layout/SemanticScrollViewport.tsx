import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useStationTheme } from "../../../theme/index.js";
import { useStationHoverEnabled } from "../stationMouseContext.js";
import {
  createScrollViewportController,
  type ScrollViewportController,
} from "./scrollViewport.js";
import { stationScrollbarOptions } from "./stationScrollbar.js";

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

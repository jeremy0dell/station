import type { ScrollBoxRenderable } from "@opentui/core";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { ScrollViewportController } from "./scrollViewport.js";

/** Flex-sized viewport that binds semantic item identities to OpenTUI scroll geometry. */
export function SemanticScrollViewport<ItemId extends string>({
  controller,
  itemIds,
  children,
  fill = true,
}: {
  controller: ScrollViewportController<ItemId>;
  itemIds: readonly ItemId[];
  children: ReactNode;
  /** Fill a definite parent height; intrinsic overlays leave this false and only shrink at max-height. */
  fill?: boolean;
}) {
  const ref = useRef<ScrollBoxRenderable>(null);
  const itemIdsRef = useRef(itemIds);
  itemIdsRef.current = itemIds;
  const itemIdentity = itemIds.join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reattach only when semantic identity changes, not when a selector returns a new array.
  useLayoutEffect(() => {
    const viewport = ref.current;
    if (viewport === null) return;
    controller.attach(viewport, itemIdsRef.current);
    queueMicrotask(controller.reflow);
    return () => controller.detach(viewport);
  }, [controller, itemIdentity]);

  return (
    <scrollbox
      ref={ref}
      width="100%"
      flexGrow={fill ? 1 : 0}
      flexShrink={1}
      {...(fill ? { flexBasis: 0 } : {})}
      minHeight={0}
      scrollX={false}
      scrollY
      viewportCulling
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
      contentOptions={{ flexDirection: "column" }}
      onSizeChange={() => queueMicrotask(controller.reflow)}
      onMouseScroll={() => queueMicrotask(controller.synchronize)}
    >
      {children}
    </scrollbox>
  );
}

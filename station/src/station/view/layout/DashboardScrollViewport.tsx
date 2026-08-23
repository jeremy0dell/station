import type { ScrollBoxRenderable } from "@opentui/core";
import type { DashboardRowId } from "@station/dashboard-core/selectors";
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { DashboardScrollController } from "./scrollViewport.js";

export function useDashboardVisibleRows(
  controller: DashboardScrollController,
): readonly DashboardRowId[] | undefined {
  return useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
}

/** Flex-sized OpenTUI viewport bound to the sole dashboard cell-geometry controller. */
export function DashboardScrollViewport({
  controller,
  itemIds,
  children,
}: {
  controller: DashboardScrollController;
  itemIds: readonly DashboardRowId[];
  children: ReactNode;
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
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
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

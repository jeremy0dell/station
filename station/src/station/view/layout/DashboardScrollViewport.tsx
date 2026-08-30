import type { DashboardRowId } from "@station/dashboard-core/selectors";
import { useSyncExternalStore, type ReactNode } from "react";
import { SemanticScrollViewport } from "./SemanticScrollViewport.js";
import type { DashboardScrollController } from "./dashboardScrollController.js";

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
  return (
    <SemanticScrollViewport controller={controller} itemIds={itemIds} scrollbar="gutter">
      {children}
    </SemanticScrollViewport>
  );
}

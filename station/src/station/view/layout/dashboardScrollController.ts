import type { DashboardVisibleRowsSource } from "@station/dashboard-core/runtime";
import type { DashboardRowId } from "@station/dashboard-core/selectors";
import {
  createScrollViewportController,
  type ScrollViewportController,
} from "./scrollViewport.js";

export type DashboardScrollController = ScrollViewportController<DashboardRowId> & {
  readonly visibleRows: DashboardVisibleRowsSource;
};

export function createDashboardScrollController(): DashboardScrollController {
  const controller = createScrollViewportController<DashboardRowId>();
  return {
    ...controller,
    visibleRows: { visibleRowIds: controller.visibility.visibleItemIds },
  };
}

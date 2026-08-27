import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import { DashboardDividerView } from "./DashboardDividerView.js";
import { DashboardFooterView } from "./DashboardFooterView.js";

/** Composes the intrinsic divider and footer controls below dashboard content. */
export function DashboardControlsView({
  state,
  columns,
}: {
  state: DashboardStateSource;
  columns: number;
}) {
  return (
    <box
      id="station-dashboard-controls"
      width="100%"
      minHeight={0}
      flexShrink={0}
      flexDirection="column"
      paddingRight={1}
      overflow="hidden"
    >
      <DashboardDividerView />
      <DashboardFooterView state={state} columns={columns} />
    </box>
  );
}

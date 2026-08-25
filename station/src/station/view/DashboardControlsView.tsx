import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { CommandPromptView } from "./CommandPromptView.js";
import { DashboardDividerView } from "./DashboardDividerView.js";
import { DashboardFooterView } from "./DashboardFooterView.js";

/** Orders the intrinsic prompt, divider, and footer controls below dashboard content. */
export function DashboardControlsView({
  state,
  screen,
  columns,
}: {
  state: DashboardStateSource;
  screen: DashboardScreenView;
  columns: number;
}) {
  return (
    <box
      id="station-dashboard-controls"
      width="100%"
      minHeight={0}
      flexShrink={1}
      flexDirection="column"
      paddingRight={1}
      overflow="hidden"
    >
      <CommandPromptView screen={screen} />
      <DashboardDividerView />
      <DashboardFooterView state={state} columns={columns} />
    </box>
  );
}

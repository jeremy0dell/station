import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { CommandPromptView } from "./CommandPromptView.js";
import { DashboardDividerView } from "./DashboardDividerView.js";
import { DashboardFooterView } from "./DashboardFooterView.js";

/** Intrinsic bottom chrome; children own their content while this parent owns their order. */
export function DashboardChromeView({
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
      id="station-dashboard-chrome"
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

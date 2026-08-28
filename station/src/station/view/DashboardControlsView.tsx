import type { DashboardStateSource } from "@station/dashboard-core/runtime";
import { DashboardDividerView } from "./DashboardDividerView.js";
import { DashboardFooterView } from "./DashboardFooterView.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";

/** Composes the intrinsic divider and footer controls below dashboard content. */
export function DashboardControlsView({
  state,
  columns,
  dividerTitle,
}: {
  state: DashboardStateSource;
  columns: number;
  dividerTitle?: string;
}) {
  const dispatch = useStationMouse();
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
      <box
        flexShrink={0}
        {...(dividerTitle === undefined
          ? {}
          : stationMouseProps(dispatch, { kind: "scrollIndicator", direction: "down" }))}
      >
        <DashboardDividerView
          {...(dividerTitle === undefined ? {} : { title: dividerTitle })}
        />
      </box>
      <DashboardFooterView state={state} columns={columns} />
    </box>
  );
}

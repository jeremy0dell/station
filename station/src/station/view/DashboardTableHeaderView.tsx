import { scrollIndicatorLabel } from "@station/dashboard-core/selectors";
import type { DashboardSessionOverflow, DashboardTableHeaderModel, RowGridLayout } from "@station/dashboard-core/selectors";
import { DashboardFilterView } from "./DashboardFilterView.js";
import { Segments } from "./segments.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

export function DashboardTableHeaderView({ model }: { model: DashboardTableHeaderModel }) {
  switch (model.kind) {
    case "persistentFilter":
      return <DashboardFilterView model={model.filter} />;
    case "columns":
      return <ColumnHeaderRow layout={model.layout} />;
    case "aboveOverflow":
      return <DashboardScrollIndicatorView direction="above" overflow={model.overflow} visible />;
    case "empty":
      return <box height={1} />;
    default:
      return assertNeverDashboardTableHeaderModel(model);
  }
}

function assertNeverDashboardTableHeaderModel(_model: never): never {
  throw new Error("Unhandled dashboard table header model.");
}

export function DashboardScrollIndicatorView({
  direction,
  overflow,
  visible,
}: {
  direction: "above" | "below";
  overflow: DashboardSessionOverflow;
  visible: boolean;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  return (
    <box height={1} flexShrink={0}>
      {visible ? (
        <text
          fg={toOpenTuiColor(theme.text.muted)}
          selectable={false}
          {...stationMouseProps(dispatch, {
            kind: "scrollIndicator",
            direction: direction === "above" ? "up" : "down",
          })}
        >
          {scrollIndicatorLabel(direction, overflow)}
        </text>
      ) : null}
    </box>
  );
}

function ColumnHeaderRow({ layout }: { layout: RowGridLayout }) {
  const theme = useStationTheme();
  return (
    <box height={1} width="100%" flexShrink={0} overflow="hidden">
      <text fg={toOpenTuiColor(theme.text.muted)}>
        <Segments segments={layout.segments} />
      </text>
    </box>
  );
}

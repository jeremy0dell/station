import { scrollIndicatorLabel } from "@station/dashboard-core";
import type {
  DashboardSessionOverflow,
  DashboardTableHeaderModel,
  RowGridLayout,
} from "@station/dashboard-core";
import { Segments } from "./segments.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";
import { STATION_COLORS } from "./theme.js";

export function DashboardTableHeaderView({ model }: { model: DashboardTableHeaderModel }) {
  switch (model.kind) {
    case "columns":
      return <ColumnHeaderRow layout={model.layout} />;
    case "aboveOverflow":
      return <DashboardScrollIndicatorView direction="above" overflow={model.overflow} />;
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
}: {
  direction: "above" | "below";
  overflow: DashboardSessionOverflow;
}) {
  const dispatch = useStationMouse();
  const hiddenSessions = direction === "above" ? overflow.above : overflow.below;
  return (
    <box height={1}>
      {hiddenSessions > 0 ? (
        <text
          fg={STATION_COLORS.gray}
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
  return (
    <box height={1} width="100%" overflow="hidden">
      <text fg={STATION_COLORS.gray}>
        <Segments segments={layout.segments} />
      </text>
    </box>
  );
}

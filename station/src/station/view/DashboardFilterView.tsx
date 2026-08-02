import { TextAttributes } from "@opentui/core";
import type {
  DashboardFilterHeaderModel,
  DashboardFilterHeaderSegment,
} from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";

export function DashboardFilterView({ model }: { model: DashboardFilterHeaderModel }) {
  const background =
    model.kind === "editing"
      ? STATION_COLORS.filterEditorSurface
      : STATION_COLORS.filterAppliedSurface;
  return (
    <box width="100%" height={1} overflow="hidden" backgroundColor={background}>
      <text width="100%">
        {model.segments.map((segment, index) => (
          <span
            key={`${segment.role}:${index}`}
            fg={filterSegmentForeground(segment, model.zeroMatches)}
            attributes={filterSegmentAttributes(segment)}
          >
            {segment.text}
          </span>
        ))}
      </text>
    </box>
  );
}

function filterSegmentForeground(
  segment: DashboardFilterHeaderSegment,
  zeroMatches: boolean,
): string {
  switch (segment.role) {
    case "rail":
    case "slash":
    case "caret":
      return STATION_COLORS.filterEditorRail;
    case "label":
    case "spacer":
      return STATION_COLORS.gray;
    case "count":
      return zeroMatches ? STATION_COLORS.filterZeroMatch : STATION_COLORS.gray;
    case "query":
      return STATION_COLORS.foreground;
  }
}

function filterSegmentAttributes(segment: DashboardFilterHeaderSegment): number {
  return segment.role === "caret" || segment.role === "label"
    ? TextAttributes.BOLD
    : TextAttributes.NONE;
}

import { TextAttributes } from "@opentui/core";
import type {
  DashboardFilterHeaderModel,
  DashboardFilterHeaderSegment,
} from "@station/dashboard-core";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationColor,
  type StationTheme,
} from "../../theme/index.js";

export function DashboardFilterView({ model }: { model: DashboardFilterHeaderModel }) {
  const theme = useStationTheme();
  const background =
    model.kind === "editing" ? theme.filter.editorSurface : theme.filter.appliedSurface;
  return (
    <box
      width="100%"
      height={1}
      overflow="hidden"
      backgroundColor={toOpenTuiOpaqueColor(background)}
    >
      <text width="100%">
        {model.segments.map((segment, index) => (
          <span
            key={`${segment.role}:${index}`}
            fg={toOpenTuiColor(filterSegmentForeground(theme, segment, model.zeroMatches))}
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
  theme: StationTheme,
  segment: DashboardFilterHeaderSegment,
  zeroMatches: boolean,
): StationColor {
  switch (segment.role) {
    case "rail":
    case "slash":
    case "caret":
      return theme.filter.editorRail;
    case "label":
    case "spacer":
    case "conditionSeparator":
    case "conditionOperator":
      return theme.text.muted;
    case "conditionField":
      return theme.action.primary;
    case "conditionValue":
      return conditionValueForeground(theme, segment);
    case "count":
      return zeroMatches ? theme.filter.zeroMatch : theme.text.muted;
    case "query":
      return theme.text.primary;
  }
}

function conditionValueForeground(
  theme: StationTheme,
  segment: DashboardFilterHeaderSegment,
): StationColor {
  if (segment.field === "project") return theme.action.primary;
  if (segment.field === "agent") return theme.status.accent;
  switch (segment.valueId) {
    case "needs_attention":
    case "stuck":
      return theme.status.danger;
    case "working":
    case "starting":
      return theme.status.working;
    case "idle":
      return theme.status.success;
    case "unknown":
      return theme.status.warning;
    case "none":
    case "exited":
    default:
      return theme.status.neutral;
  }
}

function filterSegmentAttributes(segment: DashboardFilterHeaderSegment): number {
  return segment.role === "caret" ||
    segment.role === "label" ||
    segment.role === "conditionField"
    ? TextAttributes.BOLD
    : TextAttributes.NONE;
}

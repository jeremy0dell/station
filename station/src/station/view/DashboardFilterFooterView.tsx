import { TextAttributes, type ColorInput } from "@opentui/core";
import type { DashboardFilterFooterSegment } from "@station/dashboard-core";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";
import {
  stationMouseProps,
  useStationMouse,
  type StationMouseDispatch,
} from "./stationMouseContext.js";

export function DashboardFilterFooterView({
  segments,
  variant,
}: {
  segments: readonly DashboardFilterFooterSegment[];
  variant: "editing" | "condition" | "applied";
}) {
  const theme = useStationTheme();
  return (
    <box
      height={1}
      width="100%"
      flexDirection="row"
      {...footerBackground(theme, variant)}
    >
      {segments.map((segment, index) => (
        <FilterFooterSegment key={`${segment.role}:${index}`} segment={segment} />
      ))}
    </box>
  );
}

function FilterFooterSegment({ segment }: { segment: DashboardFilterFooterSegment }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const emphasized = segment.role === "badge" || segment.role === "key";
  return (
    <text
      flexShrink={0}
      fg={footerSegmentForeground(theme, segment)}
      attributes={emphasized ? TextAttributes.BOLD : TextAttributes.NONE}
      {...footerSegmentBackground(theme, segment)}
      {...footerSegmentInteraction(dispatch, segment)}
    >
      {segment.text}
    </text>
  );
}

function footerBackground(
  theme: StationTheme,
  variant: "editing" | "condition" | "applied",
): { backgroundColor?: ColorInput } {
  if (variant === "editing") {
    return { backgroundColor: toOpenTuiOpaqueColor(theme.filter.editorSurface) };
  }
  if (variant === "condition") {
    return { backgroundColor: toOpenTuiOpaqueColor(theme.filter.conditionSurface) };
  }
  return {};
}

function footerSegmentBackground(
  theme: StationTheme,
  segment: DashboardFilterFooterSegment,
): { bg?: ColorInput } {
  return segment.role === "badge" ? { bg: toOpenTuiColor(theme.filter.editorRail) } : {};
}

function footerSegmentInteraction(
  dispatch: StationMouseDispatch,
  segment: DashboardFilterFooterSegment,
): Partial<ReturnType<typeof stationMouseProps>> {
  if (segment.action === undefined) {
    return {};
  }
  return stationMouseProps(dispatch, {
    kind: "persistentFilterAction",
    actionId: segment.action,
  });
}

function footerSegmentForeground(
  theme: StationTheme,
  segment: DashboardFilterFooterSegment,
): ColorInput {
  if (segment.role === "badge") return toOpenTuiColor(theme.text.inverse);
  if (segment.role === "key") return toOpenTuiColor(theme.text.primary);
  return toOpenTuiColor(theme.text.muted);
}

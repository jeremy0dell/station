import { TextAttributes, type ColorInput } from "@opentui/core";
import type { DashboardFilterFooterSegment } from "@station/dashboard-core";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";

export function DashboardFilterFooterView({
  segments,
}: {
  segments: readonly DashboardFilterFooterSegment[];
}) {
  const theme = useStationTheme();
  return (
    <box
      height={1}
      width="100%"
      backgroundColor={toOpenTuiOpaqueColor(theme.filter.editorSurface)}
    >
      <text width="100%">
        {segments.map((segment, index) => (
          <DashboardFilterFooterSegmentView
            key={`${segment.role}:${index}`}
            segment={segment}
            theme={theme}
          />
        ))}
      </text>
    </box>
  );
}

function DashboardFilterFooterSegmentView({
  segment,
  theme,
}: {
  segment: DashboardFilterFooterSegment;
  theme: StationTheme;
}) {
  const badge = segment.role === "badge";
  const key = segment.role === "key";
  return (
    <span
      fg={footerSegmentForeground(theme, segment)}
      {...(badge ? { bg: toOpenTuiColor(theme.filter.editorRail) } : {})}
      attributes={badge || key ? TextAttributes.BOLD : TextAttributes.NONE}
    >
      {segment.text}
    </span>
  );
}

function footerSegmentForeground(
  theme: StationTheme,
  segment: DashboardFilterFooterSegment,
): ColorInput {
  if (segment.role === "badge") return toOpenTuiColor(theme.text.inverse);
  if (segment.role === "key") return toOpenTuiColor(theme.text.primary);
  return toOpenTuiColor(theme.text.muted);
}

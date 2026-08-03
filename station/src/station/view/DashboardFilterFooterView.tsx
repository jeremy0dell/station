import { TextAttributes } from "@opentui/core";
import type { DashboardFilterFooterSegment } from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";

export function DashboardFilterFooterView({
  segments,
}: {
  segments: readonly DashboardFilterFooterSegment[];
}) {
  return (
    <box height={1} width="100%" backgroundColor={STATION_COLORS.filterEditorSurface}>
      <text width="100%">
        {segments.map((segment, index) => (
          <DashboardFilterFooterSegmentView key={`${segment.role}:${index}`} segment={segment} />
        ))}
      </text>
    </box>
  );
}

function DashboardFilterFooterSegmentView({ segment }: { segment: DashboardFilterFooterSegment }) {
  const badge = segment.role === "badge";
  const key = segment.role === "key";
  return (
    <span
      fg={footerSegmentForeground(segment)}
      {...(badge ? { bg: STATION_COLORS.filterEditorRail } : {})}
      attributes={badge || key ? TextAttributes.BOLD : TextAttributes.NONE}
    >
      {segment.text}
    </span>
  );
}

function footerSegmentForeground(segment: DashboardFilterFooterSegment): string {
  if (segment.role === "badge") return STATION_COLORS.background;
  if (segment.role === "key") return STATION_COLORS.foreground;
  return STATION_COLORS.gray;
}

import { TextAttributes, type ColorInput } from "@opentui/core";
import type { DashboardFilterFooterSegment } from "@station/dashboard-core";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";
import { stationMouseProps, useStationMouse } from "./stationMouseContext.js";

export function DashboardFilterFooterView({
  segments,
  variant,
}: {
  segments: readonly DashboardFilterFooterSegment[];
  variant: "editing" | "applied";
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  return (
    <box
      height={1}
      width="100%"
      flexDirection="row"
      {...(variant === "editing"
        ? { backgroundColor: toOpenTuiOpaqueColor(theme.filter.editorSurface) }
        : {})}
    >
      {segments.map((segment, index) => {
        const badge = segment.role === "badge";
        const key = segment.role === "key";
        return (
          <text
            key={`${segment.role}:${index}`}
            flexShrink={0}
            fg={footerSegmentForeground(theme, segment)}
            {...(badge ? { bg: toOpenTuiColor(theme.filter.editorRail) } : {})}
            attributes={badge || key ? TextAttributes.BOLD : TextAttributes.NONE}
            {...(segment.action === undefined
              ? {}
              : stationMouseProps(dispatch, {
                  kind: "persistentFilterAction",
                  actionId: segment.action,
                }))}
          >
            {segment.text}
          </text>
        );
      })}
    </box>
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

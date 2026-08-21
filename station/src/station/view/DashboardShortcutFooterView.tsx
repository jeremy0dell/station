import { TextAttributes } from "@opentui/core";
import type { DashboardFilterFooterSegment } from "@station/dashboard-core/selectors";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
} from "../../theme/index.js";

export function DashboardShortcutFooterView({
  segments,
}: {
  segments: readonly DashboardFilterFooterSegment[];
}) {
  const theme = useStationTheme();
  return (
    <box
      height={1}
      width="100%"
      flexDirection="row"
      backgroundColor={toOpenTuiOpaqueColor(theme.filter.editorSurface)}
    >
      {segments.map((segment, index) => {
        const emphasized = segment.role === "badge" || segment.role === "key";
        return (
          <text
            key={`${segment.role}:${index}`}
            flexShrink={0}
            selectable={false}
            fg={toOpenTuiColor(
              segment.role === "badge"
                ? theme.text.inverse
                : segment.role === "key"
                  ? theme.text.primary
                  : theme.text.muted,
            )}
            attributes={emphasized ? TextAttributes.BOLD : TextAttributes.NONE}
            {...(segment.role === "badge"
              ? { bg: toOpenTuiColor(theme.filter.editorRail) }
              : {})}
          >
            {segment.text}
          </text>
        );
      })}
    </box>
  );
}

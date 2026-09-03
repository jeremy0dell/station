import type { ReactNode } from "react";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import { alphaColor, stationColorSnapshot } from "../../theme/types.js";

const MEMBER_FOCUS_BORDER_OPACITY = 0.55;

export type GroupFrameFocus = {
  focusedHeader: boolean;
  containsFocusedRow: boolean;
};

export function GroupFrameHeaderRule({ focus }: { focus: GroupFrameFocus }) {
  const borderColor = useGroupFrameBorderColor(focus);
  return (
    <box
      minWidth={0}
      height={1}
      flexGrow={1}
      border={["top"]}
      borderColor={borderColor}
    />
  );
}

export function GroupFrameView({
  renderableId,
  focus,
  children,
}: {
  renderableId?: string;
  focus: GroupFrameFocus;
  children: ReactNode;
}) {
  const borderColor = useGroupFrameBorderColor(focus);
  return (
    // Keep the border unclipped: OpenTUI's bordered scissor drops the final content row from hit-testing.
    <box
      {...(renderableId === undefined ? {} : { id: renderableId })}
      width="100%"
      flexDirection="column"
      border={["left", "right", "bottom"]}
      borderStyle="rounded"
      borderColor={borderColor}
      paddingLeft={1}
      paddingRight={1}
      overflow="visible"
    >
      {children}
      {/* Overlay the top corners so the frame starts on the header's semantic row. */}
      <text position="absolute" top={0} left={-1} fg={borderColor}>
        ╭─
      </text>
      <text position="absolute" top={0} right={-1} fg={borderColor}>
        ─╮
      </text>
    </box>
  );
}

/** Renderer-boundary width available between the frame's two-cell header markers. */
export function groupFrameContentColumns(columns: number): number {
  return Math.max(1, Math.floor(columns) - 4);
}

function useGroupFrameBorderColor(focus: GroupFrameFocus) {
  const theme = useStationTheme();
  const borderColor = focus.focusedHeader
    ? theme.status.working
    : focus.containsFocusedRow
      ? alphaColor(
          stationColorSnapshot(theme.status.working),
          MEMBER_FOCUS_BORDER_OPACITY,
        )
      : theme.interaction.hairline;
  return toOpenTuiColor(borderColor);
}

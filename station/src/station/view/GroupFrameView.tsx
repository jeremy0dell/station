import type { ReactNode } from "react";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";

export type GroupFrameFocus = {
  focusedHeader: boolean;
  containsFocusedRow: boolean;
};

export function GroupFrameView({
  renderableId,
  focus,
  children,
}: {
  renderableId?: string;
  focus: GroupFrameFocus;
  children: ReactNode;
}) {
  const theme = useStationTheme();
  const emphasized = focus.focusedHeader || focus.containsFocusedRow;
  return (
    // Keep the border unclipped: OpenTUI's bordered scissor drops the final content row from hit-testing.
    <box
      {...(renderableId === undefined ? {} : { id: renderableId })}
      width="100%"
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={toOpenTuiColor(
        emphasized ? theme.status.working : theme.interaction.hairline,
      )}
      overflow="visible"
    >
      {children}
    </box>
  );
}

/** Renderer-boundary width available inside the frame's two vertical border cells. */
export function groupFrameContentColumns(columns: number): number {
  return Math.max(1, Math.floor(columns) - 2);
}

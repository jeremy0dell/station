import {
  emptyProjectLabel,
  withRowGridSelectionSlot,
  type DashboardRowId,
  type DashboardTreeRow,
  type RowGridLayout,
} from "@station/dashboard-core/selectors";
import { memo, useMemo } from "react";
import { toOpenTuiColor, useStationTheme } from "../../../theme/index.js";
import { SegmentLinkTargets, Segments } from "../segments.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";

export function DashboardLeafView({
  row,
  layout,
  keyByRow,
}: {
  row: DashboardTreeRow;
  layout: RowGridLayout | undefined;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const theme = useStationTheme();
  switch (row.payload.type) {
    case "emptyProject":
      return (
        <box id={semanticItemRenderableId(row.id)} flexDirection="row">
          <text fg={toOpenTuiColor(theme.text.muted)}>{emptyProjectLabel()}</text>
          <EmptySessionButton rowId={row.id} focused={row.focusedCellId === "addSession"} />
        </box>
      );
    case "session":
      return layout === undefined ? null : (
        <SessionRowLine
          rowId={row.id}
          layout={layout}
          slot={keyByRow.get(row.payload.row.id)}
          focused={row.focusedCellId === "identity"}
        />
      );
    case "createLocalRow": {
      // Local create rows have no slot and no activation target.
      if (layout === undefined) return null;
      return (
        <box id={semanticItemRenderableId(row.id)} flexDirection="column" width="100%">
          <text fg={toOpenTuiColor(theme.text.primary)}>
            <Segments segments={layout.segments} />
          </text>
          {row.payload.row.status === "failed" ? (
            <text fg={toOpenTuiColor(theme.status.danger)}>{row.payload.row.error.message}</text>
          ) : null}
        </box>
      );
    }
    case "projectHeader":
    case "groupHeader":
      return null;
  }
}

const SessionRowLine = memo(function SessionRowLine({
  rowId,
  layout,
  slot,
  focused,
}: {
  rowId: DashboardRowId;
  layout: RowGridLayout;
  slot: string | undefined;
  focused?: boolean;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const visibleLayout = useMemo(
    () => withRowGridSelectionSlot(layout, slot),
    [layout, slot],
  );
  // Persistent cursor fill sits under the transient hover fill.
  const background = hover
    ? { backgroundColor: toOpenTuiColor(theme.interaction.hover) }
    : focused === true
      ? { backgroundColor: toOpenTuiColor(theme.interaction.keyboardFocus) }
      : {};
  // Compact row-grid presentation is an intentional single-cell-high leaf layout.
  return (
    <box
      id={semanticItemRenderableId(rowId)}
      flexDirection="row"
      height={1}
      width="100%"
      {...background}
    >
      <box flexGrow={1} onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}>
        <text
          width="100%"
          fg={toOpenTuiColor(theme.text.primary)}
          {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "identity" })}
        >
          <Segments segments={visibleLayout.segments} />
        </text>
        <SegmentLinkTargets segments={visibleLayout.segments} />
      </box>
    </box>
  );
});

const EMPTY_SESSION_BUTTON_LABEL = "[ + add session ]";

/** Paints and activates only the empty project's bounded Add Session cells. */
function EmptySessionButton({ rowId, focused }: { rowId: DashboardRowId; focused: boolean }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const background = hover
    ? { bg: toOpenTuiColor(theme.action.primary) }
    : focused
      ? { bg: toOpenTuiColor(theme.interaction.compactFocus) }
      : {};
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(hover ? theme.text.inverse : theme.action.primary)}
      {...background}
      {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "addSession" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {EMPTY_SESSION_BUTTON_LABEL}
    </text>
  );
}

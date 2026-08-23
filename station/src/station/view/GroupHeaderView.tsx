import { TextAttributes, type ColorInput } from "@opentui/core";
import { textMatchSegments } from "@station/dashboard-core/selectors";
import type {
  DashboardCellId,
  DashboardGroupHeaderPayload,
  DashboardPersistentFilterGroupMatch,
  DashboardRowId,
} from "@station/dashboard-core/selectors";
import { Fragment } from "react";
import {
  toOpenTuiColor,
  useStationTheme,
  type StationTheme,
} from "../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";
import { dashboardQuickSessionActionLabel } from "./dashboardHeaderActionLabels.js";

const MENU_LABEL = "[▾]";

type GroupHeaderAction = {
  cellId: "quickSession" | "menu";
  label: string;
};

export function GroupHeaderView({
  renderableId,
  columns,
  rowId,
  payload,
  cells,
  focusedCellId,
}: {
  renderableId?: string;
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  cells: readonly DashboardCellId[];
  focusedCellId?: DashboardCellId | undefined;
}) {
  const actions = groupHeaderActions(cells, Math.max(1, Math.floor(columns)));
  const dimmed = payload.persistentFilterMatch?.matched === false;
  return (
    <box
      {...(renderableId === undefined ? {} : { id: renderableId })}
      width="100%"
      flexDirection="row"
      overflow="hidden"
      paddingLeft={payload.collapsed ? 1 : 0}
    >
      <box minWidth={0} flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
        <GroupIdentityTarget
          rowId={rowId}
          payload={payload}
          focused={focusedCellId === "identity"}
          dimmed={dimmed}
          persistentFilterMatch={payload.persistentFilterMatch}
        />
        <box flexGrow={1} />
      </box>
      {actions.map((action) => (
        <Fragment key={action.cellId}>
          <GroupActionCursor
            focused={focusedCellId === action.cellId}
            dimmed={dimmed}
          />
          <GroupActionTarget
            label={action.label}
            rowId={rowId}
            cellId={action.cellId}
            focused={focusedCellId === action.cellId}
            dimmed={dimmed}
          />
        </Fragment>
      ))}
    </box>
  );
}

function groupHeaderActions(
  cells: readonly DashboardCellId[],
  columns: number,
): GroupHeaderAction[] {
  const actions: GroupHeaderAction[] = [];
  if (cells.includes("quickSession")) {
    actions.push({ cellId: "quickSession", label: dashboardQuickSessionActionLabel(columns) });
  }
  if (cells.includes("menu")) {
    actions.push({ cellId: "menu", label: MENU_LABEL });
  }
  return actions;
}

function GroupIdentityTarget({
  rowId,
  payload,
  focused,
  dimmed,
  persistentFilterMatch,
}: {
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  focused: boolean;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterGroupMatch | undefined;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const count =
    payload.visibleSessionCount === payload.sessionCount
      ? `${payload.sessionCount} ${payload.sessionCount === 1 ? "session" : "sessions"}`
      : `${payload.visibleSessionCount} visible`;
  return (
    <text
      flexShrink={0}
      wrapMode="none"
      fg={toOpenTuiColor(theme.text.primary)}
      attributes={TextAttributes.BOLD | (dimmed ? TextAttributes.DIM : TextAttributes.NONE)}
      {...groupTargetBackground(theme, hover, focused)}
      {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "identity" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {focused ? "▸" : " "}
      {payload.collapsed ? "▶ " : "▼ "}
      {textMatchSegments(payload.group.name, persistentFilterMatch?.labelRanges ?? []).map(
        (segment, index) => (
          <GroupNameSegment key={`${index}:${segment.text}`} segment={segment} />
        ),
      )}
      <span fg={toOpenTuiColor(theme.text.muted)}>{` ${count}`}</span>
    </text>
  );
}

function GroupNameSegment({
  segment,
}: {
  segment: ReturnType<typeof textMatchSegments>[number];
}) {
  const theme = useStationTheme();
  return segment.matched ? (
    <span
      fg={toOpenTuiColor(theme.filter.matchForeground)}
      bg={toOpenTuiColor(theme.filter.matchBackground)}
    >
      {segment.text}
    </span>
  ) : (
    <span>{segment.text}</span>
  );
}

function GroupActionTarget({
  label,
  rowId,
  cellId,
  focused,
  dimmed,
}: {
  label: string;
  rowId: DashboardRowId;
  cellId: "quickSession" | "menu";
  focused: boolean;
  dimmed: boolean;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(hover ? theme.status.success : theme.text.muted)}
      attributes={dimmed ? TextAttributes.DIM : TextAttributes.NONE}
      {...groupTargetBackground(theme, hover, focused)}
      {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {label}
    </text>
  );
}

function GroupActionCursor({ focused, dimmed }: { focused: boolean; dimmed: boolean }) {
  const theme = useStationTheme();
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(focused ? theme.status.working : theme.text.muted)}
      attributes={dimmed ? TextAttributes.DIM : TextAttributes.NONE}
    >
      {focused ? "▸" : " "}
    </text>
  );
}

function groupTargetBackground(
  theme: StationTheme,
  hover: boolean,
  focused: boolean,
): { bg?: ColorInput } {
  if (hover) {
    return { bg: toOpenTuiColor(theme.interaction.hover) };
  }
  return focused ? { bg: toOpenTuiColor(theme.interaction.compactFocus) } : {};
}

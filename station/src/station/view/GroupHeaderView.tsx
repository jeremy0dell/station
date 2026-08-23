import { TextAttributes, type ColorInput } from "@opentui/core";
import {
  textMatchSegments,
  truncateCells,
} from "@station/dashboard-core/selectors";
import type {
  DashboardCellId,
  DashboardGroupHeaderPayload,
  DashboardPersistentFilterGroupMatch,
  DashboardRowId,
} from "@station/dashboard-core/selectors";
import { Fragment } from "react";
import stringWidth from "string-width";
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
import { GroupFrameText, type GroupFrameFocus } from "./GroupFrameView.js";

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
  containsFocusedRow,
}: {
  renderableId?: string;
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  cells: readonly DashboardCellId[];
  focusedCellId?: DashboardCellId | undefined;
  containsFocusedRow?: true | undefined;
}) {
  const width = Math.max(1, Math.floor(columns));
  const actions = groupHeaderActions(cells, width);
  const focus = {
    focusedHeader: focusedCellId !== undefined,
    containsFocusedRow: containsFocusedRow === true,
  };
  return payload.collapsed ? (
    <CollapsedGroupHeader
      columns={width}
      renderableId={renderableId}
      rowId={rowId}
      payload={payload}
      actions={actions}
      focusedCellId={focusedCellId}
    />
  ) : (
    <ExpandedGroupHeader
      columns={width}
      renderableId={renderableId}
      rowId={rowId}
      payload={payload}
      actions={actions}
      focusedCellId={focusedCellId}
      focus={focus}
    />
  );
}

function ExpandedGroupHeader({
  renderableId,
  columns,
  rowId,
  payload,
  actions,
  focusedCellId,
  focus,
}: {
  renderableId?: string;
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  actions: readonly GroupHeaderAction[];
  focusedCellId?: DashboardCellId | undefined;
  focus: GroupFrameFocus;
}) {
  const actionsWidth = groupHeaderActionsWidth(actions);
  const minimumFillWidth = actions.length === 0 ? 1 : 0;
  const identity = groupIdentityLayout(
    payload,
    Math.max(0, columns - 1 - 1 - actionsWidth - minimumFillWidth - 1),
  );
  const fillWidth = Math.max(
    minimumFillWidth,
    columns - 1 - 1 - identity.width - actionsWidth - 1,
  );
  return (
    <box id={renderableId} flexDirection="row" width="100%" height={1} overflow="hidden">
      <GroupFrameText text="╭" focus={focus} />
      <GroupIdentityTarget
        rowId={rowId}
        layout={identity}
        focused={focusedCellId === "identity"}
        dimmed={payload.persistentFilterMatch?.matched === false}
        persistentFilterMatch={payload.persistentFilterMatch}
      />
      {fillWidth > 0 ? <GroupFrameText text={"─".repeat(fillWidth)} focus={focus} /> : null}
      {actions.map((action) => (
        <Fragment key={action.cellId}>
          <GroupFrameText
            text={focusedCellId === action.cellId ? "▸" : " "}
            focus={focus}
          />
          <GroupActionTarget
            label={action.label}
            rowId={rowId}
            cellId={action.cellId}
            focused={focusedCellId === action.cellId}
            dimmed={payload.persistentFilterMatch?.matched === false}
          />
        </Fragment>
      ))}
      <GroupFrameText text="╮" focus={focus} />
    </box>
  );
}

function CollapsedGroupHeader({
  renderableId,
  columns,
  rowId,
  payload,
  actions,
  focusedCellId,
}: {
  renderableId?: string;
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  actions: readonly GroupHeaderAction[];
  focusedCellId?: DashboardCellId | undefined;
}) {
  const identity = groupIdentityLayout(
    payload,
    Math.max(0, columns - 1 - 1 - groupHeaderActionsWidth(actions)),
  );
  const dimmed = payload.persistentFilterMatch?.matched === false;
  return (
    <box id={renderableId} flexDirection="row" width="100%" height={1} overflow="hidden">
      <text flexShrink={0}> </text>
      <GroupIdentityTarget
        rowId={rowId}
        layout={identity}
        focused={focusedCellId === "identity"}
        dimmed={dimmed}
        persistentFilterMatch={payload.persistentFilterMatch}
      />
      <box flexGrow={1} height={1} />
      {actions.map((action) => (
        <Fragment key={action.cellId}>
          <CollapsedGroupActionCursor
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

function groupHeaderActionsWidth(actions: readonly GroupHeaderAction[]): number {
  // Every action reserves one inert cursor cell so focus cannot change width or pointer geometry.
  return actions.reduce((width, action) => width + 1 + stringWidth(action.label), 0);
}

function GroupIdentityTarget({
  rowId,
  layout,
  focused,
  dimmed,
  persistentFilterMatch,
}: {
  rowId: DashboardRowId;
  layout: GroupIdentityLayout;
  focused: boolean;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterGroupMatch | undefined;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(theme.text.primary)}
      attributes={TextAttributes.BOLD | (dimmed ? TextAttributes.DIM : TextAttributes.NONE)}
      {...groupTargetBackground(theme, hover, focused)}
      {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "identity" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {focused ? "▸" : " "}
      {layout.prefix}
      {textMatchSegments(layout.name, persistentFilterMatch?.labelRanges ?? []).map(
        (segment, index) => (
          <GroupNameSegment key={`${index}:${segment.text}`} segment={segment} />
        ),
      )}
      {layout.count.length > 0 ? (
        <span fg={toOpenTuiColor(theme.text.muted)}>{` ${layout.count}`}</span>
      ) : null}
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

function CollapsedGroupActionCursor({
  focused,
  dimmed,
}: {
  focused: boolean;
  dimmed: boolean;
}) {
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

type GroupIdentityLayout = {
  prefix: string;
  name: string;
  count: string;
  width: number;
};

function groupIdentityLayout(
  payload: DashboardGroupHeaderPayload,
  maxWidth: number,
): GroupIdentityLayout {
  const prefix = `${payload.collapsed ? "▶" : "▼"} `;
  const count =
    payload.visibleSessionCount === payload.sessionCount
      ? `${payload.sessionCount} ${payload.sessionCount === 1 ? "session" : "sessions"}`
      : `${payload.visibleSessionCount} visible`;
  for (const candidate of [count, String(payload.visibleSessionCount), ""]) {
    const suffix = candidate.length === 0 ? "" : ` ${candidate}`;
    const width = stringWidth(prefix) + stringWidth(payload.group.name) + stringWidth(suffix);
    if (width <= maxWidth) {
      return { prefix, name: payload.group.name, count: candidate, width };
    }
  }
  const prefixWidth = Math.min(maxWidth, stringWidth(prefix));
  const visiblePrefix = truncateCells(prefix, prefixWidth);
  const visibleName = truncateCells(payload.group.name, Math.max(0, maxWidth - prefixWidth));
  return {
    prefix: visiblePrefix,
    name: visibleName,
    count: "",
    width: stringWidth(visiblePrefix) + stringWidth(visibleName),
  };
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

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
import { GroupFrameText, type GroupFrameFocus } from "./GroupFrameView.js";

const QUICK_SESSION_LABEL = "[qs]";
const MENU_LABEL = "[▾]";
const EXPANDED_FIXED_WIDTH = 1 + 1 + QUICK_SESSION_LABEL.length + 1 + MENU_LABEL.length + 1;
const COLLAPSED_FIXED_WIDTH = 1 + 1 + QUICK_SESSION_LABEL.length + 1 + MENU_LABEL.length;

export function GroupHeaderView({
  columns,
  rowId,
  payload,
  focusedCellId,
  containsFocusedRow,
}: {
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  focusedCellId?: DashboardCellId | undefined;
  containsFocusedRow?: true | undefined;
}) {
  const width = Math.max(1, Math.floor(columns));
  const focus = {
    focusedHeader: focusedCellId !== undefined,
    containsFocusedRow: containsFocusedRow === true,
  };
  return payload.collapsed ? (
    <CollapsedGroupHeader
      columns={width}
      rowId={rowId}
      payload={payload}
      focusedCellId={focusedCellId}
    />
  ) : (
    <ExpandedGroupHeader
      columns={width}
      rowId={rowId}
      payload={payload}
      focusedCellId={focusedCellId}
      focus={focus}
    />
  );
}

function ExpandedGroupHeader({
  columns,
  rowId,
  payload,
  focusedCellId,
  focus,
}: {
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  focusedCellId?: DashboardCellId | undefined;
  focus: GroupFrameFocus;
}) {
  const identity = groupIdentityLayout(payload, Math.max(0, columns - EXPANDED_FIXED_WIDTH));
  const fillWidth = Math.max(
    1,
    columns -
      1 -
      identity.width -
      QUICK_SESSION_LABEL.length -
      1 -
      MENU_LABEL.length -
      1,
  );
  return (
    <box flexDirection="row" width="100%" height={1} overflow="hidden">
      <GroupFrameText text="╭" focus={focus} />
      <GroupIdentityTarget
        rowId={rowId}
        layout={identity}
        focused={focusedCellId === "identity"}
        dimmed={payload.persistentFilterMatch?.matched === false}
        persistentFilterMatch={payload.persistentFilterMatch}
      />
      <GroupFrameText text={"─".repeat(fillWidth)} focus={focus} />
      <GroupActionTarget
        label={QUICK_SESSION_LABEL}
        rowId={rowId}
        cellId="quickSession"
        focused={focusedCellId === "quickSession"}
        dimmed={payload.persistentFilterMatch?.matched === false}
      />
      <GroupFrameText text=" " focus={focus} />
      <GroupActionTarget
        label={MENU_LABEL}
        rowId={rowId}
        cellId="menu"
        focused={focusedCellId === "menu"}
        dimmed={payload.persistentFilterMatch?.matched === false}
      />
      <GroupFrameText text="╮" focus={focus} />
    </box>
  );
}

function CollapsedGroupHeader({
  columns,
  rowId,
  payload,
  focusedCellId,
}: {
  columns: number;
  rowId: DashboardRowId;
  payload: DashboardGroupHeaderPayload;
  focusedCellId?: DashboardCellId | undefined;
}) {
  const identity = groupIdentityLayout(payload, Math.max(0, columns - COLLAPSED_FIXED_WIDTH));
  const dimmed = payload.persistentFilterMatch?.matched === false;
  return (
    <box flexDirection="row" width="100%" height={1} overflow="hidden">
      <text flexShrink={0}> </text>
      <GroupIdentityTarget
        rowId={rowId}
        layout={identity}
        focused={focusedCellId === "identity"}
        dimmed={dimmed}
        persistentFilterMatch={payload.persistentFilterMatch}
      />
      <box flexGrow={1} height={1} />
      <text flexShrink={0}> </text>
      <GroupActionTarget
        label={QUICK_SESSION_LABEL}
        rowId={rowId}
        cellId="quickSession"
        focused={focusedCellId === "quickSession"}
        dimmed={dimmed}
      />
      <text flexShrink={0}> </text>
      <GroupActionTarget
        label={MENU_LABEL}
        rowId={rowId}
        cellId="menu"
        focused={focusedCellId === "menu"}
        dimmed={dimmed}
      />
    </box>
  );
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

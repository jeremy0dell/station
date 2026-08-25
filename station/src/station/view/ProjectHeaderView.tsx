import { TextAttributes, type ColorInput } from "@opentui/core";
import { projectHeaderLabelParts, textMatchSegments } from "@station/dashboard-core/selectors";
import type {
  DashboardCellId,
  DashboardPersistentFilterProjectMatch,
  DashboardRowId,
} from "@station/dashboard-core/selectors";
import type { DashboardSnapshotView } from "@station/dashboard-core/state";

type DashboardProjectView = DashboardSnapshotView["projects"][number];
import { toOpenTuiColor, useStationTheme, type StationTheme } from "../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";
import {
  dashboardQuickSessionActionLabel,
  dashboardShellActionLabel,
} from "./dashboardHeaderActionLabels.js";

const MENU_AFFORDANCE_LABEL = "[▾]";

export function ProjectHeaderView({
  renderableId,
  columns,
  rowId,
  project,
  collapsed,
  groupCount,
  focusedCellId,
  persistentFilterMatch,
}: {
  renderableId?: string;
  columns: number;
  rowId: DashboardRowId;
  project: DashboardProjectView;
  collapsed: boolean;
  groupCount: number;
  focusedCellId?: DashboardCellId | undefined;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const shellLabel = dashboardShellActionLabel(columns);
  const quickSessionLabel = dashboardQuickSessionActionLabel(columns);
  const dimmed = persistentFilterMatch?.matched === false;
  return (
    <box id={renderableId} flexDirection="row" width="100%" overflow="hidden">
      <ProjectHeaderPrimary
        rowId={rowId}
        project={project}
        collapsed={collapsed}
        groupCount={groupCount}
        focused={focusedCellId === "identity"}
        dimmed={dimmed}
        persistentFilterMatch={persistentFilterMatch}
      />
      <ProjectHeaderCursor focused={focusedCellId === "shell"} dimmed={dimmed} />
      <ProjectHeaderAction
        label={shellLabel}
        rowId={rowId}
        cellId="shell"
        focused={focusedCellId === "shell"}
        dimmed={dimmed}
      />
      <ProjectHeaderCursor focused={focusedCellId === "quickSession"} dimmed={dimmed} />
      <ProjectHeaderAction
        label={quickSessionLabel}
        rowId={rowId}
        cellId="quickSession"
        focused={focusedCellId === "quickSession"}
        dimmed={dimmed}
      />
      <ProjectHeaderCursor focused={focusedCellId === "menu"} dimmed={dimmed} />
      <ProjectHeaderAction
        label={MENU_AFFORDANCE_LABEL}
        rowId={rowId}
        cellId="menu"
        focused={focusedCellId === "menu"}
        dimmed={dimmed}
      />
    </box>
  );
}

function ProjectHeaderPrimary({
  rowId,
  project,
  collapsed,
  groupCount,
  focused,
  dimmed,
  persistentFilterMatch,
}: {
  rowId: DashboardRowId;
  project: DashboardProjectView;
  collapsed: boolean;
  groupCount: number;
  focused: boolean;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <box minWidth={0} flexGrow={1} flexShrink={1} flexDirection="row" overflow="hidden">
      <text
        flexShrink={0}
        wrapMode="none"
        fg={toOpenTuiColor(theme.text.primary)}
        attributes={dimmed ? TextAttributes.DIM : TextAttributes.NONE}
        {...projectHeaderBackground(theme, hover, focused)}
        {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "identity" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {focused ? "▸" : " "}
        <ProjectHeaderLabel
          project={project}
          collapsed={collapsed}
          groupCount={groupCount}
          dimmed={dimmed}
          persistentFilterMatch={persistentFilterMatch}
        />
      </text>
      <box flexGrow={1} />
    </box>
  );
}

// Each action's preceding cursor cell stays inert so whitespace cannot activate the action.
function ProjectHeaderAction({
  label,
  rowId,
  cellId,
  focused,
  dimmed,
}: {
  label: string;
  rowId: DashboardRowId;
  cellId: DashboardCellId;
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
      {...projectHeaderBackground(theme, hover, focused)}
      {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {label}
    </text>
  );
}

function ProjectHeaderCursor({ focused, dimmed }: { focused: boolean; dimmed: boolean }) {
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

function ProjectHeaderLabel({
  project,
  collapsed,
  groupCount,
  dimmed,
  persistentFilterMatch,
}: {
  project: DashboardProjectView;
  collapsed: boolean;
  groupCount: number;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const theme = useStationTheme();
  const parts = projectHeaderLabelParts(project, collapsed, groupCount);
  return (
    <>
      <ProjectHeaderLabelText
        prefix={`${collapsed ? "▶" : "▼"} `}
        label={project.label}
        ranges={persistentFilterMatch?.labelRanges ?? []}
        dimmed={dimmed}
      />
      <span fg={toOpenTuiColor(theme.text.muted)}>{parts.counts}</span>
    </>
  );
}

function ProjectHeaderLabelText({
  prefix,
  label,
  ranges,
  dimmed,
}: {
  prefix: string;
  label: string;
  ranges: readonly { start: number; end: number }[];
  dimmed: boolean;
}) {
  return (
    <span attributes={TextAttributes.BOLD | (dimmed ? TextAttributes.DIM : TextAttributes.NONE)}>
      {prefix}
      {textMatchSegments(label, ranges).map((segment, index) => (
        <ProjectHeaderMatchSegment key={`${index}:${segment.text}`} segment={segment} />
      ))}
    </span>
  );
}

function ProjectHeaderMatchSegment({
  segment,
}: {
  segment: ReturnType<typeof textMatchSegments>[number];
}) {
  const theme = useStationTheme();
  if (!segment.matched) {
    return <span>{segment.text}</span>;
  }
  return (
    <span
      fg={toOpenTuiColor(theme.filter.matchForeground)}
      bg={toOpenTuiColor(theme.filter.matchBackground)}
    >
      {segment.text}
    </span>
  );
}

function projectHeaderBackground(
  theme: StationTheme,
  hover: boolean,
  focused: boolean,
): { bg?: ColorInput } {
  if (hover) {
    return { bg: toOpenTuiColor(theme.interaction.hover) };
  }
  if (focused) {
    return { bg: toOpenTuiColor(theme.interaction.compactFocus) };
  }
  return {};
}

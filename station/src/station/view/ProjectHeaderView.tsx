import { TextAttributes, type ColorInput } from "@opentui/core";
import { projectHeaderLabelParts, textMatchSegments, truncateCells } from "@station/dashboard-core/selectors";
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
const PROJECT_HEADER_SEPARATOR_COUNT = 3;

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
  const controlsWidth =
    shellLabel.length +
    quickSessionLabel.length +
    MENU_AFFORDANCE_LABEL.length +
    PROJECT_HEADER_SEPARATOR_COUNT;
  const dimmed = persistentFilterMatch?.matched === false;
  return (
    <box id={renderableId} flexDirection="row" width="100%" height={1} overflow="hidden">
      <ProjectHeaderPrimary
        rowId={rowId}
        project={project}
        collapsed={collapsed}
        groupCount={groupCount}
        width={Math.max(1, columns - controlsWidth)}
        focused={focusedCellId === "identity"}
        dimmed={dimmed}
        persistentFilterMatch={persistentFilterMatch}
      />
      <box flexGrow={1} height={1} />
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
  width,
  focused,
  dimmed,
  persistentFilterMatch,
}: {
  rowId: DashboardRowId;
  project: DashboardProjectView;
  collapsed: boolean;
  groupCount: number;
  width: number;
  focused: boolean;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
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
        width={Math.max(0, width - 1)}
        dimmed={dimmed}
        persistentFilterMatch={persistentFilterMatch}
      />
    </text>
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
  width,
  dimmed,
  persistentFilterMatch,
}: {
  project: DashboardProjectView;
  collapsed: boolean;
  groupCount: number;
  width: number;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const theme = useStationTheme();
  const parts = projectHeaderLabelParts(project, collapsed, groupCount);
  const combined = truncateCells(`${parts.title}${parts.counts}`, width);
  const title = combined.slice(0, parts.title.length);
  const prefixLength = Math.min(title.length, parts.title.length - project.label.length);
  const prefix = title.slice(0, prefixLength);
  const label = title.slice(prefixLength);
  return (
    <>
      <ProjectHeaderLabelText
        prefix={prefix}
        label={label}
        ranges={persistentFilterMatch?.labelRanges ?? []}
        dimmed={dimmed}
      />
      <span fg={toOpenTuiColor(theme.text.muted)}>{combined.slice(parts.title.length)}</span>
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

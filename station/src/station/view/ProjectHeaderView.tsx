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

const SHELL_AFFORDANCE_LABEL = "[shell]";
const SHELL_AFFORDANCE_LABEL_COMPACT = "[sh]";
const DEFAULT_AGENT_AFFORDANCE_LABEL = "[▾]";
const QUICK_SESSION_AFFORDANCE_LABEL = "[quick session]";
const QUICK_SESSION_AFFORDANCE_LABEL_COMPACT = "[qs]";
const PROJECT_HEADER_SEPARATOR_COUNT = 3;
const RESPONSIVE_AFFORDANCE_BREAKPOINT = 90;

export function ProjectHeaderView({
  columns,
  rowId,
  project,
  collapsed,
  groupCount,
  focusedCellId,
  persistentFilterMatch,
}: {
  columns: number;
  rowId: DashboardRowId;
  project: DashboardProjectView;
  collapsed: boolean;
  groupCount: number;
  focusedCellId?: DashboardCellId | undefined;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const compact = columns < RESPONSIVE_AFFORDANCE_BREAKPOINT;
  const shellLabel = compact ? SHELL_AFFORDANCE_LABEL_COMPACT : SHELL_AFFORDANCE_LABEL;
  const quickSessionLabel = compact
    ? QUICK_SESSION_AFFORDANCE_LABEL_COMPACT
    : QUICK_SESSION_AFFORDANCE_LABEL;
  const controlsWidth =
    shellLabel.length +
    quickSessionLabel.length +
    DEFAULT_AGENT_AFFORDANCE_LABEL.length +
    PROJECT_HEADER_SEPARATOR_COUNT;
  const dimmed = persistentFilterMatch?.matched === false;
  return (
    <box flexDirection="row" width="100%" height={1} overflow="hidden">
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
      <ProjectHeaderSeparator dimmed={dimmed} />
      <ProjectHeaderAction
        label={shellLabel}
        rowId={rowId}
        cellId="shell"
        focused={focusedCellId === "shell"}
        dimmed={dimmed}
      />
      <ProjectHeaderSeparator dimmed={dimmed} />
      <ProjectHeaderAction
        label={quickSessionLabel}
        rowId={rowId}
        cellId="quickSession"
        focused={focusedCellId === "quickSession"}
        dimmed={dimmed}
      />
      <ProjectHeaderSeparator dimmed={dimmed} />
      <ProjectHeaderAction
        label={DEFAULT_AGENT_AFFORDANCE_LABEL}
        rowId={rowId}
        cellId="defaultAgent"
        focused={focusedCellId === "defaultAgent"}
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
      <ProjectHeaderLabel
        project={project}
        collapsed={collapsed}
        groupCount={groupCount}
        width={width}
        dimmed={dimmed}
        persistentFilterMatch={persistentFilterMatch}
      />
    </text>
  );
}

// Each action has its own trailing cell so its click cannot also toggle the project header.
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

function ProjectHeaderSeparator({ dimmed }: { dimmed: boolean }) {
  const theme = useStationTheme();
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(theme.text.muted)}
      attributes={dimmed ? TextAttributes.DIM : TextAttributes.NONE}
    >
      {" "}
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

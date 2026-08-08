import { TextAttributes, type ColorInput } from "@opentui/core";
import { projectHeaderLabelParts, textMatchSegments, truncateCells } from "@station/dashboard-core/selectors";
import type { DashboardPersistentFilterProjectMatch } from "@station/dashboard-core/selectors";
import type { DashboardSnapshotView, ProjectHeaderControl } from "@station/dashboard-core/state";

type DashboardProjectView = DashboardSnapshotView["projects"][number];
import { toOpenTuiColor, useStationTheme, type StationTheme } from "../../theme/index.js";
import type { StationMouseTarget } from "../input/stationMouse.js";
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
  project,
  collapsed,
  focus,
  persistentFilterMatch,
}: {
  columns: number;
  project: DashboardProjectView;
  collapsed: boolean;
  focus?: ProjectHeaderControl | undefined;
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
        project={project}
        collapsed={collapsed}
        width={Math.max(1, columns - controlsWidth)}
        focused={focus === "primary"}
        dimmed={dimmed}
        persistentFilterMatch={persistentFilterMatch}
      />
      <box flexGrow={1} height={1} />
      <ProjectHeaderSeparator dimmed={dimmed} />
      <ProjectHeaderAction
        label={shellLabel}
        target={{ kind: "openShellForProject", projectId: project.id }}
        focused={focus === "shell"}
        dimmed={dimmed}
      />
      <ProjectHeaderSeparator dimmed={dimmed} />
      <ProjectHeaderAction
        label={quickSessionLabel}
        target={{ kind: "quickSessionForProject", projectId: project.id }}
        focused={focus === "quickSession"}
        dimmed={dimmed}
      />
      <ProjectHeaderSeparator dimmed={dimmed} />
      <ProjectHeaderAction
        label={DEFAULT_AGENT_AFFORDANCE_LABEL}
        target={{ kind: "showDefaultAgentPickerForProject", projectId: project.id }}
        focused={focus === "defaultAgent"}
        dimmed={dimmed}
      />
    </box>
  );
}

function ProjectHeaderPrimary({
  project,
  collapsed,
  width,
  focused,
  dimmed,
  persistentFilterMatch,
}: {
  project: DashboardProjectView;
  collapsed: boolean;
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
      {...stationMouseProps(dispatch, { kind: "projectHeader", projectId: project.id })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <ProjectHeaderLabel
        project={project}
        collapsed={collapsed}
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
  target,
  focused,
  dimmed,
}: {
  label: string;
  target: StationMouseTarget;
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
      {...stationMouseProps(dispatch, target)}
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
  width,
  dimmed,
  persistentFilterMatch,
}: {
  project: DashboardProjectView;
  collapsed: boolean;
  width: number;
  dimmed: boolean;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const theme = useStationTheme();
  const parts = projectHeaderLabelParts(project, collapsed);
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

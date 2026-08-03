import { TextAttributes } from "@opentui/core";
import type { ProjectView } from "@station/contracts";
import {
  projectHeaderLabelParts,
  textMatchSegments,
  truncateCells,
  type DashboardPersistentFilterProjectMatch,
  type ProjectHeaderControl,
} from "@station/dashboard-core";
import type { StationMouseTarget } from "../input/stationMouse.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";
import { STATION_COLORS } from "./theme.js";

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
  project: ProjectView;
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
  return (
    <box flexDirection="row" width="100%" height={1} overflow="hidden">
      <ProjectHeaderPrimary
        project={project}
        collapsed={collapsed}
        width={Math.max(1, columns - controlsWidth)}
        focused={focus === "primary"}
        persistentFilterMatch={persistentFilterMatch}
      />
      <box flexGrow={1} height={1} />
      <ProjectHeaderSeparator />
      <ProjectHeaderAction
        label={shellLabel}
        target={{ kind: "openShellForProject", projectId: project.id }}
        focused={focus === "shell"}
      />
      <ProjectHeaderSeparator />
      <ProjectHeaderAction
        label={quickSessionLabel}
        target={{ kind: "quickSessionForProject", projectId: project.id }}
        focused={focus === "quickSession"}
      />
      <ProjectHeaderSeparator />
      <ProjectHeaderAction
        label={DEFAULT_AGENT_AFFORDANCE_LABEL}
        target={{ kind: "showDefaultAgentPickerForProject", projectId: project.id }}
        focused={focus === "defaultAgent"}
      />
    </box>
  );
}

function ProjectHeaderPrimary({
  project,
  collapsed,
  width,
  focused,
  persistentFilterMatch,
}: {
  project: ProjectView;
  collapsed: boolean;
  width: number;
  focused: boolean;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
      fg={STATION_COLORS.foreground}
      {...projectHeaderBackground(hover, focused)}
      {...stationMouseProps(dispatch, { kind: "projectHeader", projectId: project.id })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <ProjectHeaderLabel
        project={project}
        collapsed={collapsed}
        width={width}
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
}: {
  label: string;
  target: StationMouseTarget;
  focused: boolean;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
      fg={hover ? STATION_COLORS.green : STATION_COLORS.gray}
      {...projectHeaderBackground(hover, focused)}
      {...stationMouseProps(dispatch, target)}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {label}
    </text>
  );
}

function ProjectHeaderSeparator() {
  return (
    <text flexShrink={0} fg={STATION_COLORS.gray}>
      {" "}
    </text>
  );
}

function ProjectHeaderLabel({
  project,
  collapsed,
  width,
  persistentFilterMatch,
}: {
  project: ProjectView;
  collapsed: boolean;
  width: number;
  persistentFilterMatch?: DashboardPersistentFilterProjectMatch | undefined;
}) {
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
      />
      <span fg={STATION_COLORS.gray}>{combined.slice(parts.title.length)}</span>
    </>
  );
}

function ProjectHeaderLabelText({
  prefix,
  label,
  ranges,
}: {
  prefix: string;
  label: string;
  ranges: readonly { start: number; end: number }[];
}) {
  return (
    <span attributes={TextAttributes.BOLD}>
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
  if (!segment.matched) {
    return <span>{segment.text}</span>;
  }
  return (
    <span fg={STATION_COLORS.filterMatchForeground} bg={STATION_COLORS.filterMatchBackground}>
      {segment.text}
    </span>
  );
}

function projectHeaderBackground(hover: boolean, focused: boolean): { bg?: string } {
  if (hover) {
    return { bg: STATION_COLORS.hoverBackground };
  }
  if (focused) {
    return { bg: STATION_COLORS.compactFocusBackground };
  }
  return {};
}

// Render layer for the dashboard: one <text> per line, sized by the shared
// viewport selector. Mouse targets report through the station mouse context;
// hover is component-local and color-only so golden frames stay layout-stable.
import { TextAttributes } from "@opentui/core";
import type { ProjectView, SessionId, StationSnapshot } from "@station/contracts";
import {
  dashboardFooterLabel,
  fleetCountsLabel,
  emptyProjectLabel,
  FIRST_RUN_BODY_LABEL,
  projectHeaderLabelParts,
  rowGridInputForViewportItem,
  scrollIndicatorLabel,
} from "@station/dashboard-core";
import {
  layoutWorktreeRowGrid,
  textSegment,
  truncateCells,
  type RowGridLayout,
  type RowGridRowInput,
} from "@station/dashboard-core";
import {
  QUIT_HINT_CLOSE,
  selectDashboardViewport,
  selectFleetSummary,
  type DashboardSessionOverflow,
  type DashboardViewportItem,
  type FleetSummary,
} from "@station/dashboard-core";
import type { TuiViewState } from "@station/dashboard-core";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { SegmentLinkTargets, Segments } from "./segments.js";
import { Throbber } from "./Throbber.js";
import { STATION_COLORS } from "./theme.js";
import {
  useStationHoverState,
  useStationMouse,
  stationMouseProps,
} from "./stationMouseContext.js";

const HOVER_BG = STATION_COLORS.hoverBackground;

// The per-row/header "open a shell here" click target. Rendered as its own
// trailing <text> so stationMouseProps' stopPropagation fires only this action,
// never the row-activate / collapse-toggle on the line it sits beside. The
// reserved width (label + a leading space) is subtracted from the row grid and
// header truncation so the affordance is never clipped at small viewports.
const SHELL_AFFORDANCE_LABEL = "[shell]";
const SHELL_AFFORDANCE_LABEL_COMPACT = "[sh]";
const SHELL_AFFORDANCE_WIDTH = SHELL_AFFORDANCE_LABEL.length + 1;
const SHELL_AFFORDANCE_WIDTH_COMPACT = SHELL_AFFORDANCE_LABEL_COMPACT.length + 1;

// The per-project-header quick-session affordance sits after [shell] on project
// rows: "[quick session]" creates a session (default harness), "[▾]" opens the
// project default-agent picker. Compact mode uses "[qs]" when columns are limited.
const QUICK_SESSION_AFFORDANCE_LABEL = "[quick session]";
const QUICK_SESSION_AFFORDANCE_LABEL_COMPACT = "[qs]";
// Reserved width: leading space + session label + space + [▾]
const QUICK_SESSION_AFFORDANCE_WIDTH = ` ${QUICK_SESSION_AFFORDANCE_LABEL} [▾]`.length;
const QUICK_SESSION_AFFORDANCE_WIDTH_COMPACT = ` ${QUICK_SESSION_AFFORDANCE_LABEL_COMPACT} [▾]`.length;

// Below this terminal width the header affordances switch to compact labels.
const RESPONSIVE_AFFORDANCE_BREAKPOINT = 90;

export type DashboardViewProps = {
  snapshot: StationSnapshot;
  viewState: TuiViewState;
  columns?: number;
};

const QUIT_HINT = QUIT_HINT_CLOSE;

export function DashboardView({
  snapshot,
  viewState,
  columns = 80,
}: DashboardViewProps) {
  const dispatch = useStationMouse();
  const viewport = selectDashboardViewport(snapshot, viewState);
  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const firstRun = snapshot.projects.length === 0;
  const fleet = selectFleetSummary(snapshot);
  const keyByRow = new Map(viewport.displayRowChoices.map((choice) => [choice.value.id, choice.key]));
  const { headerLayout, layoutByItem } = firstRun
    ? { headerLayout: undefined, layoutByItem: new Map<string, RowGridLayout>() }
    : dashboardRowLayouts(viewport.visibleItems, keyByRow, contentColumns, viewState.focusedRowId);
  return (
    <box
      width="100%"
      flexGrow={1}
      flexDirection="column"
      paddingRight={1}
      onMouseScroll={stationMouseProps(dispatch, { kind: "body" }).onMouseScroll}
    >
      <text> </text>
      {firstRun ? null : (
        <FleetBar summary={fleet} counts={snapshot.counts} columns={contentColumns} />
      )}
      <Divider columns={contentColumns} />
      {/* One shared row: column headers at rest, the above-overflow count while scrolled. */}
      {viewport.sessionOverflow.above > 0 || headerLayout === undefined ? (
        <ScrollIndicatorRow direction="above" overflow={viewport.sessionOverflow} />
      ) : (
        <ColumnHeaderRow layout={headerLayout} />
      )}
      {firstRun ? (
        <box flexDirection="column" flexGrow={1}>
          <text fg={STATION_COLORS.foreground}>{truncateCells(FIRST_RUN_BODY_LABEL, contentColumns)}</text>
        </box>
      ) : (
        <DashboardBody
          columns={contentColumns}
          items={viewport.visibleItems}
          layoutByItem={layoutByItem}
          focusedRowId={viewState.focusedRowId}
        />
      )}
      <ScrollIndicatorRow direction="below" overflow={viewport.sessionOverflow} />
      <Divider columns={contentColumns} />
      <text fg={STATION_COLORS.foreground}>
        {truncateCells(
          dashboardFooterLabel({ columns: contentColumns, quitHint: QUIT_HINT, firstRun }),
          contentColumns,
        )}
      </text>
    </box>
  );
}

export function Divider({ columns }: { columns: number }) {
  return <text fg={STATION_COLORS.gray}>{"─".repeat(Math.max(1, columns))}</text>;
}

// Pinned fleet triage bar: glyph + colour reinforce each status lane. ready/
// working/needs-you/idle always show; unknown/exited appear only when non-zero
// (M2's lane order — before idle). The right side carries the fleet totals.
function FleetBar({
  summary,
  counts,
  columns,
}: {
  summary: FleetSummary;
  counts: { projects: number; sessions: number; agents: number };
  columns: number;
}) {
  const parts: { glyph: string; color: string; label: string; animate?: boolean }[] = [
    { glyph: "●", color: STATION_COLORS.green, label: `${summary.ready} ready` },
    {
      glyph: "⠿",
      color: STATION_COLORS.blue,
      label: `${summary.working} working`,
      animate: summary.working > 0,
    },
    { glyph: "!", color: STATION_COLORS.red, label: `${summary.needsYou} needs you` },
  ];
  if (summary.unknown > 0) {
    parts.push({ glyph: "?", color: STATION_COLORS.yellow, label: `${summary.unknown} unknown` });
  }
  if (summary.exited > 0) {
    parts.push({ glyph: "x", color: STATION_COLORS.gray, label: `${summary.exited} exited` });
  }
  parts.push({ glyph: "○", color: STATION_COLORS.gray, label: `${summary.idle} idle` });
  const lanesWidth =
    "FLEET".length + parts.reduce((total, part) => total + 3 + 1 + part.label.length, 0);
  const totals = fleetCountsLabel(
    { projects: counts.projects, sessions: counts.sessions, agents: counts.agents },
    Math.max(0, columns - lanesWidth - 2),
  );
  return (
    <box height={1} width="100%" flexDirection="row" overflow="hidden">
      <text flexGrow={1} fg={STATION_COLORS.gray}>
        <span attributes={TextAttributes.BOLD}>FLEET</span>
        {parts.map((part) => (
          <span key={part.label}>
            {"  "}
            {part.animate === true ? (
              <Throbber variant="braille" fg={part.color} />
            ) : (
              <span fg={part.color}>{part.glyph}</span>
            )}
            {` ${part.label}`}
          </span>
        ))}
      </text>
      {totals.length > 0 ? <text fg={STATION_COLORS.gray}>{totals}</text> : null}
    </box>
  );
}

function ColumnHeaderRow({ layout }: { layout: RowGridLayout }) {
  return (
    <box height={1} width="100%" overflow="hidden">
      <text fg={STATION_COLORS.gray}>
        <Segments segments={layout.segments} />
      </text>
    </box>
  );
}

function ScrollIndicatorRow({
  direction,
  overflow,
}: {
  direction: "above" | "below";
  overflow: DashboardSessionOverflow;
}) {
  const dispatch = useStationMouse();
  const hiddenSessions = direction === "above" ? overflow.above : overflow.below;
  return (
    <box height={1}>
      {hiddenSessions > 0 ? (
        <text
          fg={STATION_COLORS.gray}
          {...stationMouseProps(dispatch, {
            kind: "scrollIndicator",
            direction: direction === "above" ? "up" : "down",
          })}
        >
          {scrollIndicatorLabel(direction, overflow)}
        </text>
      ) : null}
    </box>
  );
}

const COLUMN_HEADER_ROW_ID = "__column_header__";

function columnHeaderRowInput(): RowGridRowInput {
  return {
    id: COLUMN_HEADER_ROW_ID,
    cells: {
      identity: { key: "identity", segments: [textSegment(" ".repeat(7))], importance: "required" },
      title: { key: "title", segments: [textSegment("SESSION")], importance: "required" },
      agent: { key: "agent", segments: [textSegment("AGENT")], importance: "optional" },
      activity: { key: "activity", segments: [textSegment("STATUS")], importance: "optional" },
    },
    // The trailing middot composes to "DIFF · PR" via the groups' joining space,
    // and the ladder sheds diff first, so the dot can never be orphaned.
    metadataGroups: { diff: [textSegment("DIFF ·")], pr: [textSegment("PR")] },
  };
}

// The header shares the rows' grid layout so its columns align and shed in lockstep.
function dashboardRowLayouts(
  items: readonly DashboardViewportItem[],
  keyByRow: ReadonlyMap<string, string>,
  columns: number,
  focusedRowId?: SessionId,
): { headerLayout: RowGridLayout | undefined; layoutByItem: Map<string, RowGridLayout> } {
  const rowInputs = items.flatMap((item) => {
    const input = rowGridInputForViewportItem(item, keyByRow, focusedRowId);
    return input === undefined ? [] : [input];
  });
  const layouts = layoutWorktreeRowGrid({
    columns: Math.max(1, columns),
    rows: [columnHeaderRowInput(), ...rowInputs],
  });
  const headerLayout = layouts.find((layout) => layout.id === COLUMN_HEADER_ROW_ID);
  const layoutByItem = new Map(
    layouts.filter((layout) => layout.id !== COLUMN_HEADER_ROW_ID).map((layout) => [layout.id, layout]),
  );
  return { headerLayout, layoutByItem };
}



function DashboardBody({
  columns,
  items,
  layoutByItem,
  focusedRowId,
}: {
  columns: number;
  items: readonly DashboardViewportItem[];
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  focusedRowId?: SessionId | undefined;
}) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {items.map((item) => (
        <DashboardViewportRow
          key={item.id}
          columns={columns}
          item={item}
          layout={layoutByItem.get(item.id)}
          focusedRowId={focusedRowId}
        />
      ))}
    </box>
  );
}

function DashboardViewportRow({
  columns,
  item,
  layout,
  focusedRowId,
}: {
  columns: number;
  item: DashboardViewportItem;
  layout: RowGridLayout | undefined;
  focusedRowId?: SessionId | undefined;
}) {
  switch (item.type) {
    case "projectGap":
      return <box height={1} />;
    case "projectHeader":
      return <ProjectHeaderLine columns={columns} project={item.project} collapsed={item.collapsed} />;
    case "emptyProject":
      return (
        <box flexDirection="row" height={1}>
          <text fg={STATION_COLORS.gray}>{emptyProjectLabel()}</text>
          <EmptySessionButton projectId={item.project.id} />
        </box>
      );
    case "session":
      return layout === undefined ? null : (
        <SessionRowLine rowId={item.row.id} layout={layout} focused={item.row.id === focusedRowId} />
      );
    case "createLocalRow":
      // Local create rows have no slot and no activation target.
      return layout === undefined ? null : (
        <text fg={STATION_COLORS.foreground}>
          <Segments segments={layout.segments} />
        </text>
      );
  }
}

function SessionRowLine({
  rowId,
  layout,
  focused,
}: {
  rowId: string;
  layout: RowGridLayout;
  focused?: boolean;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  // Persistent cursor fill sits under the transient hover fill.
  const background = hover
    ? { backgroundColor: HOVER_BG }
    : focused === true
      ? { backgroundColor: STATION_COLORS.focusBackground }
      : {};
  return (
    <box flexDirection="row" width="100%" height={1} {...background}>
      <box flexGrow={1} height={1} onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}>
        <text
          width="100%"
          fg={STATION_COLORS.foreground}
          {...stationMouseProps(dispatch, { kind: "row", rowId })}
        >
          <Segments segments={layout.segments} />
        </text>
        <SegmentLinkTargets segments={layout.segments} />
      </box>
    </box>
  );
}

/**
 * The trailing `[+sh]` click target. Its own <text> (not a span) so it carries
 * its own mouse target and stopPropagation; the leading space keeps it off the
 * line content. Color-only hover, so golden frames stay layout-stable.
 */
function ShellAffordance({
  target,
  onHoverChange,
  compact,
}: {
  target: StationMouseTarget;
  onHoverChange?: ((hover: boolean) => void) | undefined;
  compact?: boolean;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const label = compact ? SHELL_AFFORDANCE_LABEL_COMPACT : SHELL_AFFORDANCE_LABEL;
  return (
    // flexShrink={0}: content grows/clips first, affordance width is never clipped.
    <text
      flexShrink={0}
      fg={hover ? STATION_COLORS.green : STATION_COLORS.gray}
      {...stationMouseProps(dispatch, target)}
      onMouseOver={() => {
        setHover(true);
        onHoverChange?.(true);
      }}
      onMouseOut={() => {
        setHover(false);
        onHoverChange?.(false);
      }}
    >
      {` ${label}`}
    </text>
  );
}

/**
 * The trailing `[quick session] [▾]` (or `[qs] [▾]` in compact mode)
 * quick-session affordance on project headers. Two separate `<text>` elements
 * so each click target fires independently: the session label immediately
 * creates a session (default harness), `[▾]` opens the default-agent picker
 * for this project.
 */
function QuickSessionAffordance({
  projectId,
  compact,
}: {
  projectId: string;
  compact?: boolean;
}) {
  const dispatch = useStationMouse();
  const [quickHover, setQuickHover] = useStationHoverState();
  const [pickerHover, setPickerHover] = useStationHoverState();
  const sessionLabel = compact ? QUICK_SESSION_AFFORDANCE_LABEL_COMPACT : QUICK_SESSION_AFFORDANCE_LABEL;
  return (
    <>
      <text
        flexShrink={0}
        fg={quickHover ? STATION_COLORS.green : STATION_COLORS.gray}
        {...stationMouseProps(dispatch, { kind: "quickSessionForProject", projectId })}
        onMouseOver={() => setQuickHover(true)}
        onMouseOut={() => setQuickHover(false)}
      >
        {` ${sessionLabel}`}
      </text>
      <text
        flexShrink={0}
        fg={pickerHover ? STATION_COLORS.green : STATION_COLORS.gray}
        {...stationMouseProps(dispatch, { kind: "showDefaultAgentPickerForProject", projectId })}
        onMouseOver={() => setPickerHover(true)}
        onMouseOut={() => setPickerHover(false)}
      >
        {" [▾]"}
      </text>
    </>
  );
}

const EMPTY_SESSION_BUTTON_LABEL = "[ + add session ]";

// Mouse-native empty-state action: one click creates a session (default agent)
// for the project — the same command as the project header's [quick session].
function EmptySessionButton({ projectId }: { projectId: string }) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      flexShrink={0}
      fg={hover ? STATION_COLORS.background : STATION_COLORS.cyan}
      {...(hover ? { bg: STATION_COLORS.cyan } : {})}
      {...stationMouseProps(dispatch, { kind: "quickSessionForProject", projectId })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {EMPTY_SESSION_BUTTON_LABEL}
    </text>
  );
}

function ProjectHeaderLine({
  columns,
  project,
  collapsed,
}: {
  columns: number;
  project: ProjectView;
  collapsed: boolean;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const compact = columns < RESPONSIVE_AFFORDANCE_BREAKPOINT;
  const shellWidth = compact ? SHELL_AFFORDANCE_WIDTH_COMPACT : SHELL_AFFORDANCE_WIDTH;
  const quickSessionWidth = compact ? QUICK_SESSION_AFFORDANCE_WIDTH_COMPACT : QUICK_SESSION_AFFORDANCE_WIDTH;
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      {...(hover ? { backgroundColor: HOVER_BG } : {})}
    >
      <text
        flexGrow={1}
        fg={STATION_COLORS.foreground}
        {...stationMouseProps(dispatch, { kind: "projectHeader", projectId: project.id })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <ProjectHeaderLabel
          project={project}
          collapsed={collapsed}
          width={Math.max(1, columns - shellWidth - quickSessionWidth)}
        />
      </text>
      <ShellAffordance
        target={{ kind: "openShellForProject", projectId: project.id }}
        onHoverChange={setHover}
        compact={compact}
      />
      <QuickSessionAffordance projectId={project.id} compact={compact} />
    </box>
  );
}

function ProjectHeaderLabel({
  project,
  collapsed,
  width,
}: {
  project: ProjectView;
  collapsed: boolean;
  width: number;
}) {
  const parts = projectHeaderLabelParts(project, collapsed);
  const combined = truncateCells(`${parts.title}${parts.counts}`, width);
  const title = combined.slice(0, parts.title.length);
  const counts = combined.slice(parts.title.length);
  return (
    <>
      <span attributes={TextAttributes.BOLD}>{title}</span>
      <span fg={STATION_COLORS.gray}>{counts}</span>
    </>
  );
}

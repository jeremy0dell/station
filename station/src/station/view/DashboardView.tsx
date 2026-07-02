// Render layer for the dashboard: one <text> per line, sized by the shared
// viewport selector. Mouse targets report through the station mouse context;
// hover is component-local and color-only so golden frames stay layout-stable.
import { TextAttributes } from "@opentui/core";
import type { ProjectView, StationSnapshot } from "@station/contracts";
import { useState } from "react";
import {
  dashboardFooterLabel,
  dashboardHeaderLine,
  emptyProjectLabel,
  FIRST_RUN_BODY_LABEL,
  projectHeaderLabel,
  rowGridInputForViewportItem,
  scrollIndicatorLabel,
  type DashboardHeaderStatus,
  type TopRowWidgetText,
} from "@station/dashboard-core";
import {
  layoutWorktreeRowGrid,
  truncateCells,
  type RowGridLayout,
} from "@station/dashboard-core";
import {
  QUIT_HINT_CLOSE,
  selectDashboardViewport,
  selectFleetSummary,
  type DashboardViewportItem,
  type FleetSummary,
} from "@station/dashboard-core";
import type { TuiViewState } from "@station/dashboard-core";
import type { StationMouseTarget } from "../input/stationMouse.js";
import { SegmentLinkTargets, Segments } from "./segments.js";
import { STATION_COLORS } from "./theme.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

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
  topRowWidgets?: readonly TopRowWidgetText[];
  observerStatus?: DashboardHeaderStatus;
};

const PRODUCT_LABEL = "station";
const QUIT_HINT = QUIT_HINT_CLOSE;

export function DashboardView({
  snapshot,
  viewState,
  columns = 80,
  topRowWidgets = [],
  observerStatus,
}: DashboardViewProps) {
  const dispatch = useStationMouse();
  const viewport = selectDashboardViewport(snapshot, viewState);
  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const firstRun = snapshot.projects.length === 0;
  const fleet = selectFleetSummary(snapshot);
  return (
    <box
      width="100%"
      flexGrow={1}
      flexDirection="column"
      paddingRight={1}
      onMouseScroll={stationMouseProps(dispatch, { kind: "body" }).onMouseScroll}
    >
      <DashboardHeaderRow
        columns={contentColumns}
        widgets={topRowWidgets}
        {...(observerStatus === undefined ? {} : { status: observerStatus })}
      />
      {firstRun ? null : <FleetBar summary={fleet} />}
      <Divider columns={contentColumns} />
      <ScrollIndicatorRow direction="above" hiddenCount={viewport.hiddenAbove} />
      {firstRun ? (
        <box flexDirection="column" flexGrow={1}>
          <text fg={STATION_COLORS.foreground}>{truncateCells(FIRST_RUN_BODY_LABEL, contentColumns)}</text>
        </box>
      ) : (
        <DashboardBody
          columns={contentColumns}
          items={viewport.visibleItems}
          keyByRow={new Map(viewport.displayRowChoices.map((choice) => [choice.value.id, choice.key]))}
        />
      )}
      <ScrollIndicatorRow direction="below" hiddenCount={viewport.hiddenBelow} />
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

export function DashboardHeaderRow({
  columns,
  widgets,
  status,
}: {
  columns: number;
  widgets: readonly TopRowWidgetText[];
  status?: DashboardHeaderStatus;
}) {
  const headerLine = dashboardHeaderLine({
    productLabel: PRODUCT_LABEL,
    columns,
    widgets,
    ...(status === undefined ? {} : { status }),
  });
  const suffix = headerLine.startsWith(PRODUCT_LABEL) ? headerLine.slice(PRODUCT_LABEL.length) : "";
  return (
    <text fg={STATION_COLORS.foreground}>
      <span attributes={TextAttributes.BOLD}>{PRODUCT_LABEL}</span>
      {suffix}
    </text>
  );
}

export function Divider({ columns }: { columns: number }) {
  return <text fg={STATION_COLORS.gray}>{"─".repeat(Math.max(1, columns))}</text>;
}

// Pinned fleet triage bar: glyph + colour reinforce each status lane. ready/
// working/needs-you/idle always show; unknown/exited appear only when non-zero.
function FleetBar({ summary }: { summary: FleetSummary }) {
  const parts: { glyph: string; color: string; label: string }[] = [
    { glyph: "●", color: STATION_COLORS.green, label: `${summary.ready} ready` },
    { glyph: "⠿", color: STATION_COLORS.blue, label: `${summary.working} working` },
    { glyph: "!", color: STATION_COLORS.red, label: `${summary.needsYou} needs you` },
    { glyph: "○", color: STATION_COLORS.gray, label: `${summary.idle} idle` },
  ];
  if (summary.unknown > 0) {
    parts.push({ glyph: "?", color: STATION_COLORS.yellow, label: `${summary.unknown} unknown` });
  }
  if (summary.exited > 0) {
    parts.push({ glyph: "x", color: STATION_COLORS.gray, label: `${summary.exited} exited` });
  }
  return (
    <box height={1} width="100%" backgroundColor={STATION_COLORS.frozenSurface} overflow="hidden">
      <text fg={STATION_COLORS.gray}>
        <span attributes={TextAttributes.BOLD}>FLEET</span>
        {parts.map((part) => (
          <span key={part.label}>
            {"  "}
            <span fg={part.color}>{part.glyph}</span>
            {` ${part.label}`}
          </span>
        ))}
      </text>
    </box>
  );
}

function ScrollIndicatorRow({
  direction,
  hiddenCount,
}: {
  direction: "above" | "below";
  hiddenCount: number;
}) {
  const dispatch = useStationMouse();
  return (
    <box height={1}>
      {hiddenCount > 0 ? (
        <text
          fg={STATION_COLORS.gray}
          {...stationMouseProps(dispatch, {
            kind: "scrollIndicator",
            direction: direction === "above" ? "up" : "down",
          })}
        >
          {scrollIndicatorLabel(direction, hiddenCount)}
        </text>
      ) : null}
    </box>
  );
}

function DashboardBody({
  columns,
  items,
  keyByRow,
}: {
  columns: number;
  items: readonly DashboardViewportItem[];
  keyByRow: ReadonlyMap<string, string>;
}) {
  const rowInputs = items.flatMap((item) => {
    const input = rowGridInputForViewportItem(item, keyByRow);
    return input === undefined ? [] : [input];
  });
  // Rows use the full content width: the per-row [shell] affordance was removed
  // (it lives on the project header now), so the diff/PR metadata reclaims the
  // right-hand column that used to be reserved for it.
  const gridColumns = Math.max(1, columns);
  const rowLayouts = layoutWorktreeRowGrid({ columns: gridColumns, rows: rowInputs });
  const layoutByItem = new Map(rowLayouts.map((layout) => [layout.id, layout]));
  return (
    <box flexDirection="column" flexGrow={1}>
      {items.map((item) => (
        <DashboardViewportRow
          key={item.id}
          columns={columns}
          item={item}
          layout={layoutByItem.get(item.id)}
        />
      ))}
    </box>
  );
}

function DashboardViewportRow({
  columns,
  item,
  layout,
}: {
  columns: number;
  item: DashboardViewportItem;
  layout: RowGridLayout | undefined;
}) {
  switch (item.type) {
    case "projectGap":
      return <box height={1} />;
    case "projectHeader":
      return <ProjectHeaderLine columns={columns} project={item.project} collapsed={item.collapsed} />;
    case "emptyProject":
      return <text fg={STATION_COLORS.gray}>{truncateCells(emptyProjectLabel(), columns)}</text>;
    case "worktree":
      return layout === undefined ? null : (
        <WorktreeRowLine rowId={item.row.id} layout={layout} />
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

function WorktreeRowLine({ rowId, layout }: { rowId: string; layout: RowGridLayout }) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      {...(hover ? { backgroundColor: HOVER_BG } : {})}
    >
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
  const [hover, setHover] = useState(false);
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
  const [quickHover, setQuickHover] = useState(false);
  const [pickerHover, setPickerHover] = useState(false);
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
  const [hover, setHover] = useState(false);
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
        attributes={TextAttributes.BOLD}
        {...stationMouseProps(dispatch, { kind: "projectHeader", projectId: project.id })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {truncateCells(
          projectHeaderLabel(project, collapsed),
          Math.max(1, columns - shellWidth - quickSessionWidth),
        )}
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

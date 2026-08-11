// Render layer for the dashboard: one <text> per line, sized by the shared
// viewport selector. Mouse targets report through the station mouse context;
// hover is component-local and color-only so golden frames stay layout-stable.
import { TextAttributes } from "@opentui/core";
import {
  dashboardTableHeaderModel,
  dashboardRowGridInput,
  fleetCountsLabel,
  emptyProjectLabel,
  FIRST_RUN_BODY_LABEL,
 } from "@station/dashboard-core/selectors";
import { layoutWorktreeRowGrid, textSegment, truncateCells } from "@station/dashboard-core/selectors";
import type { RowGridLayout, RowGridRowInput } from "@station/dashboard-core/selectors";
import { selectDashboardViewport, selectFleetSummary } from "@station/dashboard-core/selectors";
import type {
  DashboardRowId,
  DashboardTreeRow,
  FleetSummary,
} from "@station/dashboard-core/selectors";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "@station/dashboard-core/state";
import {
  DashboardScrollIndicatorView,
  DashboardTableHeaderView,
} from "./DashboardTableHeaderView.js";
import { GroupFrameEndView, GroupFrameRailView } from "./GroupFrameView.js";
import { GroupHeaderView } from "./GroupHeaderView.js";
import { ProjectHeaderView } from "./ProjectHeaderView.js";
import { SegmentLinkTargets, Segments } from "./segments.js";
import { Throbber } from "./Throbber.js";
import { FLEET_STATUS_ORDER, STATION_STATUS_UI } from "../statusUi.js";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import { useStationHoverState, useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export type DashboardViewProps = {
  snapshot: DashboardSnapshotView;
  viewState: DashboardViewState;
  screen: DashboardScreenView;
  columns?: number;
};

export function DashboardView({ snapshot, viewState, screen, columns = 80 }: DashboardViewProps) {
  const dispatch = useStationMouse();
  const viewport = selectDashboardViewport(snapshot, viewState, screen);
  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const firstRun = snapshot.projects.length === 0;
  const rowGridColumns =
    snapshot.sessionGroups.length === 0 ? contentColumns : Math.max(1, contentColumns - 2);
  const fleet = selectFleetSummary(snapshot);
  const keyByRow = new Map(
    viewport.displayRowChoices.map((choice) => [choice.value.id, choice.key]),
  );
  const { headerLayout, layoutByItem } = firstRun
    ? { headerLayout: undefined, layoutByItem: new Map<string, RowGridLayout>() }
    : dashboardRowLayouts(
        [...viewport.rowById.values()],
        keyByRow,
        rowGridColumns,
      );
  const tableHeader = dashboardTableHeaderModel({
    layout: headerLayout,
    overflow: viewport.sessionOverflow,
    columns: contentColumns,
    ...(viewport.persistentFilter === undefined
      ? {}
      : { persistentFilter: viewport.persistentFilter }),
  });
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
      <DashboardTableHeaderView model={tableHeader} />
      {firstRun ? (
        <box flexDirection="column" flexGrow={1}>
          <FirstProjectButton columns={contentColumns} />
        </box>
      ) : (
        <DashboardBody
          columns={contentColumns}
          rows={viewport.rows}
          rowById={viewport.rowById}
          layoutByItem={layoutByItem}
        />
      )}
      <DashboardScrollIndicatorView direction="below" overflow={viewport.sessionOverflow} />
      <Divider columns={contentColumns} />
    </box>
  );
}

export function Divider({ columns }: { columns: number }) {
  const theme = useStationTheme();
  return <text fg={toOpenTuiColor(theme.text.muted)}>{"─".repeat(Math.max(1, columns))}</text>;
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
  const theme = useStationTheme();
  const parts = FLEET_STATUS_ORDER.flatMap((status) => {
    const visual = STATION_STATUS_UI[status];
    const count = summary[status];
    if (visual.fleet === "hidden" || (visual.fleet === "nonzero" && count === 0)) {
      return [];
    }
    return [
      {
        glyph: visual.glyph,
        color: toOpenTuiColor(theme.status[visual.tone]),
        label: `${count} ${visual.label}`,
        animate: visual.animate && count > 0,
      },
    ];
  });
  const lanesWidth =
    "FLEET".length + parts.reduce((total, part) => total + 3 + 1 + part.label.length, 0);
  const totals = fleetCountsLabel(
    { projects: counts.projects, sessions: counts.sessions, agents: counts.agents },
    Math.max(0, columns - lanesWidth - 2),
  );
  return (
    <box height={1} width="100%" flexDirection="row" overflow="hidden">
      <text flexGrow={1} fg={toOpenTuiColor(theme.text.muted)}>
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
      {totals.length > 0 ? <text fg={toOpenTuiColor(theme.text.muted)}>{totals}</text> : null}
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
  rows: readonly DashboardTreeRow[],
  keyByRow: ReadonlyMap<string, string>,
  columns: number,
): { headerLayout: RowGridLayout | undefined; layoutByItem: Map<string, RowGridLayout> } {
  const rowInputs = rows.flatMap((row) => {
    const input = dashboardRowGridInput(row, keyByRow);
    return input === undefined ? [] : [input];
  });
  const layouts = layoutWorktreeRowGrid({
    columns: Math.max(1, columns),
    rows: [columnHeaderRowInput(), ...rowInputs],
  });
  const headerLayout = layouts.find((layout) => layout.id === COLUMN_HEADER_ROW_ID);
  const layoutByItem = new Map(
    layouts
      .filter((layout) => layout.id !== COLUMN_HEADER_ROW_ID)
      .map((layout) => [layout.id, layout]),
  );
  return { headerLayout, layoutByItem };
}

function DashboardBody({
  columns,
  rows,
  rowById,
  layoutByItem,
}: {
  columns: number;
  rows: readonly DashboardTreeRow[];
  rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
}) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {rows.map((row) => (
        <DashboardRow
          key={row.id}
          columns={columns}
          row={row}
          rowById={rowById}
          layout={layoutByItem.get(row.id)}
        />
      ))}
    </box>
  );
}

function DashboardRow({
  columns,
  row,
  rowById,
  layout,
}: {
  columns: number;
  row: DashboardTreeRow;
  rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>;
  layout: RowGridLayout | undefined;
}) {
  const theme = useStationTheme();
  // Resolve Group containment through projected ancestry so renderers never decode row IDs.
  const groupRow = groupHeaderParent(row, rowById);
  switch (row.payload.type) {
    case "projectGap":
      return <box height={1} />;
    case "projectHeader":
      return (
        <ProjectHeaderView
          columns={columns}
          rowId={row.id}
          project={row.payload.project}
          collapsed={row.payload.collapsed}
          groupCount={row.payload.groupCount}
          persistentFilterMatch={row.payload.persistentFilterMatch}
          focusedCellId={row.focusedCellId}
        />
      );
    case "groupHeader":
      return (
        <GroupHeaderView
          columns={columns}
          rowId={row.id}
          payload={row.payload}
          focusedCellId={row.focusedCellId}
          containsFocusedRow={row.containsFocusedRow}
        />
      );
    case "groupFrameEnd":
      return groupRow === undefined ? null : (
        <GroupFrameEndView
          columns={columns}
          focusedHeader={groupRow.focusedCellId !== undefined}
          containsFocusedRow={groupRow.containsFocusedRow === true}
        />
      );
    case "emptyProject":
      return (
        <box flexDirection="row" height={1}>
          <text fg={toOpenTuiColor(theme.text.muted)}>{emptyProjectLabel()}</text>
          <EmptySessionButton
            rowId={row.id}
            focused={row.focusedCellId === "addSession"}
          />
        </box>
      );
    case "session":
      return layout === undefined ? null : (
        <SessionRowLine
          rowId={row.id}
          layout={layout}
          focused={row.focusedCellId === "identity"}
          groupRow={groupRow}
        />
      );
    case "createLocalRow":
      // Local create rows have no slot and no activation target.
      return layout === undefined ? null : (
        <text fg={toOpenTuiColor(theme.text.primary)}>
          <Segments segments={layout.segments} />
        </text>
      );
  }
}

function SessionRowLine({
  rowId,
  layout,
  focused,
  groupRow,
}: {
  rowId: DashboardRowId;
  layout: RowGridLayout;
  focused?: boolean;
  groupRow?: DashboardTreeRow | undefined;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  // Persistent cursor fill sits under the transient hover fill.
  const background = hover
    ? { backgroundColor: toOpenTuiColor(theme.interaction.hover) }
    : focused === true
      ? { backgroundColor: toOpenTuiColor(theme.interaction.keyboardFocus) }
      : {};
  const content = (
    <box
      flexDirection="row"
      height={1}
      {...(groupRow === undefined ? { width: "100%" as const } : { flexGrow: 1 })}
      {...background}
    >
      <box
        flexGrow={1}
        height={1}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <text
          width="100%"
          fg={toOpenTuiColor(theme.text.primary)}
          {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "identity" })}
        >
          <Segments segments={layout.segments} />
        </text>
        <SegmentLinkTargets segments={layout.segments} />
      </box>
    </box>
  );
  if (groupRow === undefined) {
    return content;
  }
  const frame = {
    focusedHeader: groupRow.focusedCellId !== undefined,
    containsFocusedRow: groupRow.containsFocusedRow === true,
  };
  return (
    <box flexDirection="row" width="100%" height={1}>
      <GroupFrameRailView text="│" {...frame} />
      {content}
      <GroupFrameRailView text="│" {...frame} />
    </box>
  );
}

function groupHeaderParent(
  row: DashboardTreeRow,
  rowById: ReadonlyMap<DashboardRowId, DashboardTreeRow>,
): DashboardTreeRow | undefined {
  if (row.parentId === undefined) {
    return undefined;
  }
  const parent = rowById.get(row.parentId);
  return parent?.payload.type === "groupHeader" ? parent : undefined;
}

function FirstProjectButton({ columns }: { columns: number }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const label = `[ + ${FIRST_RUN_BODY_LABEL} (A) ]`;
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(hover ? theme.text.inverse : theme.action.primary)}
      attributes={TextAttributes.BOLD}
      {...(hover ? { bg: toOpenTuiColor(theme.action.primary) } : {})}
      {...stationMouseProps(dispatch, { kind: "firstProjectAdd" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {truncateCells(label, columns)}
    </text>
  );
}

const EMPTY_SESSION_BUTTON_LABEL = "[ + add session ]";

/** Paints and activates only the empty project's bounded Add Session cells. */
function EmptySessionButton({ rowId, focused }: { rowId: DashboardRowId; focused: boolean }) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const background = hover
    ? { bg: toOpenTuiColor(theme.action.primary) }
    : focused
      ? { bg: toOpenTuiColor(theme.interaction.compactFocus) }
      : {};
  return (
    <text
      flexShrink={0}
      fg={toOpenTuiColor(hover ? theme.text.inverse : theme.action.primary)}
      {...background}
      {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "addSession" })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {EMPTY_SESSION_BUTTON_LABEL}
    </text>
  );
}

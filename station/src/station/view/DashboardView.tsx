import { TextAttributes } from "@opentui/core";
import {
  dashboardRowIds,
  dashboardTableHeaderModel,
  emptyProjectLabel,
  fleetCountsLabel,
  FIRST_RUN_BODY_LABEL,
  selectDashboardSlotsForTree,
  selectDashboardTree,
  selectFleetSummary,
  withRowGridSelectionSlot,
  type DashboardRowId,
  type DashboardTreeBranch,
  type DashboardTreeRow,
  type FleetSummary,
  type RowGridLayout,
} from "@station/dashboard-core/selectors";
import { cellWidth, truncateCells } from "@station/dashboard-core/text";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "@station/dashboard-core/state";
import {
  DashboardScrollIndicatorView,
  DashboardTableHeaderView,
} from "./DashboardTableHeaderView.js";
import { GroupFrameView, groupFrameContentColumns } from "./GroupFrameView.js";
import { GroupHeaderView } from "./GroupHeaderView.js";
import { ProjectHeaderView } from "./ProjectHeaderView.js";
import { SegmentLinkTargets, Segments } from "./segments.js";
import { Throbber } from "./Throbber.js";
import { FLEET_STATUS_ORDER, STATION_STATUS_UI } from "../statusUi.js";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import {
  StationHoverProvider,
  useStationHoverState,
  useStationMouse,
  stationMouseProps,
} from "./stationMouseContext.js";
import { memo, useLayoutEffect, useMemo } from "react";
import {
  DashboardScrollViewport,
  useDashboardVisibleRows,
} from "./layout/DashboardScrollViewport.js";
import {
  semanticItemRenderableId,
  type DashboardScrollController,
} from "./layout/scrollViewport.js";
import { DashboardFilterConditionView } from "./DashboardFilterConditionView.js";
import { DashboardDividerView } from "./DashboardDividerView.js";
import { GroupMenuView } from "./GroupMenuView.js";
import { ProjectMenuView } from "./ProjectMenuView.js";
import { createDashboardRowGridProjector } from "./dashboardRowGridProjection.js";

const DASHBOARD_LAYOUT_BOUNDARY_ID = "station-dashboard-layout-boundary";

export type DashboardViewProps = {
  snapshot: DashboardSnapshotView;
  viewState: DashboardViewState;
  screen: DashboardScreenView;
  layout: DashboardScrollController;
  columns: number;
  menuHoverEnabled: boolean;
};

export function DashboardView({
  snapshot,
  viewState,
  screen,
  layout,
  columns,
  menuHoverEnabled,
}: DashboardViewProps) {
  const theme = useStationTheme();
  const visibleRowIds = useDashboardVisibleRows(layout);
  const dispatch = useStationMouse();
  const tree = useMemo(
    () => selectDashboardTree(snapshot, viewState, screen),
    [screen, snapshot, viewState],
  );
  const slots = selectDashboardSlotsForTree(tree, visibleRowIds);
  const rowGridProjector = useMemo(() => createDashboardRowGridProjector(), []);
  const itemIds = useMemo(() => tree.visibleRows.map((row) => row.id), [tree.visibleRows]);
  const contentColumns = Math.max(1, Math.floor(columns) - 1);
  const firstRun = snapshot.projects.length === 0;
  const fleet = selectFleetSummary(snapshot);
  const keyByRow = new Map(
    slots.displayRowChoices.flatMap((choice) =>
      choice.key === undefined ? [] : [[choice.value.id, choice.key] as const],
    ),
  );
  const { headerLayout, layoutByItem } = firstRun
    ? { headerLayout: undefined, layoutByItem: new Map<string, RowGridLayout>() }
    : rowGridProjector.project(tree, contentColumns);
  const tableHeader = dashboardTableHeaderModel({
    layout: headerLayout,
    overflow: slots.sessionOverflow,
    columns: contentColumns,
    ...(slots.persistentFilter === undefined
      ? {}
      : { persistentFilter: slots.persistentFilter }),
  });
  useLayoutEffect(() => {
    const focusedId = viewState.dashboardFocus?.rowId;
    queueMicrotask(() => layout.follow(focusedId));
  }, [layout, viewState.dashboardFocus?.rowId]);
  const conditionPanelActive =
    screen.name === "persistentFilter" && screen.conditionEditor !== undefined;
  const dashboardMenuActive = screen.name === "projectMenu" || screen.name === "groupMenu";
  const dashboardOwnedOverlayActive = conditionPanelActive || dashboardMenuActive;
  const menuRowId =
    screen.name === "projectMenu"
      ? dashboardRowIds.project(screen.projectId)
      : screen.name === "groupMenu"
        ? dashboardRowIds.group(screen.groupId)
        : undefined;
  const menuAnchorRenderableId =
    menuRowId !== undefined && tree.rowById.has(menuRowId)
      ? semanticItemRenderableId(menuRowId)
      : undefined;
  const menuGroup =
    screen.name === "groupMenu"
      ? snapshot.sessionGroups.find(
          (group) => group.id === screen.groupId && group.projectId === screen.projectId,
        )
      : undefined;
  // DashboardFrameTitle overlays the owning frame's top edge, so its inset belongs here.
  return (
    <box
      id={DASHBOARD_LAYOUT_BOUNDARY_ID}
      width="100%"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      flexDirection="column"
      paddingTop={1}
      paddingRight={1}
      position="relative"
    >
      {dashboardOwnedOverlayActive ? (
        <box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height="100%"
          zIndex={9}
          {...(conditionPanelActive
            ? { backgroundColor: toOpenTuiColor(theme.filter.conditionBackdrop) }
            : {})}
          {...stationMouseProps(dispatch, { kind: "screenBackdrop" })}
        />
      ) : null}
      {firstRun ? null : (
        <FleetBar summary={fleet} counts={snapshot.counts} columns={contentColumns} />
      )}
      <DashboardDividerView />
      {tableHeader !== undefined || conditionPanelActive ? (
        <box
          flexShrink={0}
          position="relative"
          {...(conditionPanelActive ? { zIndex: 10 } : {})}
        >
          {tableHeader === undefined ? null : <DashboardTableHeaderView model={tableHeader} />}
          {conditionPanelActive ? (
            <box position="absolute" top="100%" left={0}>
              <DashboardFilterConditionView
                screen={screen}
                columns={contentColumns}
                boundaryId={DASHBOARD_LAYOUT_BOUNDARY_ID}
              />
            </box>
          ) : null}
        </box>
      ) : null}
      {firstRun ? (
        <box flexDirection="column" flexGrow={1}>
          <FirstProjectButton columns={contentColumns} />
        </box>
      ) : (
        <DashboardScrollViewport controller={layout} itemIds={itemIds}>
          <DashboardBody
            columns={contentColumns}
            roots={tree.roots}
            layoutByItem={layoutByItem}
            keyByRow={keyByRow}
          />
        </DashboardScrollViewport>
      )}
      <DashboardScrollIndicatorView direction="below" overflow={slots.sessionOverflow} />
      {screen.name === "projectMenu" && menuAnchorRenderableId !== undefined ? (
        <StationHoverProvider value={menuHoverEnabled}>
          <ProjectMenuView
            screen={screen}
            boundaryId={DASHBOARD_LAYOUT_BOUNDARY_ID}
            anchorRenderableId={menuAnchorRenderableId}
          />
        </StationHoverProvider>
      ) : null}
      {screen.name === "groupMenu" &&
      menuAnchorRenderableId !== undefined &&
      menuGroup !== undefined ? (
        <StationHoverProvider value={menuHoverEnabled}>
          <GroupMenuView
            screen={screen}
            groupName={menuGroup.name}
            boundaryId={DASHBOARD_LAYOUT_BOUNDARY_ID}
            anchorRenderableId={menuAnchorRenderableId}
          />
        </StationHoverProvider>
      ) : null}
    </box>
  );
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
    cellWidth("FLEET") +
    parts.reduce((total, part) => total + cellWidth(`  ${part.glyph} ${part.label}`), 0);
  const totals = fleetCountsLabel(
    { projects: counts.projects, sessions: counts.sessions, agents: counts.agents },
    Math.max(0, columns - lanesWidth - 2),
  );
  return (
    <box height={1} flexShrink={0} width="100%" flexDirection="row" overflow="hidden">
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
      {totals !== "" ? <text fg={toOpenTuiColor(theme.text.muted)}>{totals}</text> : null}
    </box>
  );
}

function DashboardBody({
  columns,
  roots,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  roots: readonly DashboardTreeBranch[];
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  return (
    <box flexDirection="column" width="100%" gap={1}>
      {roots.map((branch) => (
        <DashboardBranchView
          key={branch.row.id}
          columns={columns}
          branch={branch}
          layoutByItem={layoutByItem}
          keyByRow={keyByRow}
        />
      ))}
    </box>
  );
}

function DashboardBranchView({
  columns,
  branch,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  branch: DashboardTreeBranch;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const row = branch.row;
  if (row.payload.type === "projectHeader") {
    return (
      <ProjectBranchView
        columns={columns}
        branch={branch}
        layoutByItem={layoutByItem}
        keyByRow={keyByRow}
      />
    );
  }
  if (row.payload.type === "groupHeader") {
    return (
      <GroupBranchView
        columns={columns}
        branch={branch}
        layoutByItem={layoutByItem}
        keyByRow={keyByRow}
      />
    );
  }
  return (
    <DashboardLeaf
      row={row}
      layout={layoutByItem.get(row.id)}
      keyByRow={keyByRow}
    />
  );
}

function ProjectBranchView({
  columns,
  branch,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  branch: DashboardTreeBranch;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const row = branch.row;
  if (row.payload.type !== "projectHeader") return null;
  return (
    <box id={`station-dashboard-project:${row.id}`} flexDirection="column" width="100%">
      <ProjectHeaderView
        renderableId={semanticItemRenderableId(row.id)}
        columns={columns}
        rowId={row.id}
        project={row.payload.project}
        collapsed={row.payload.collapsed}
        groupCount={row.payload.groupCount}
        persistentFilterMatch={row.payload.persistentFilterMatch}
        focusedCellId={row.focusedCellId}
      />
      {branch.children.map((child) => (
        <DashboardBranchView
          key={child.row.id}
          columns={columns}
          branch={child}
          layoutByItem={layoutByItem}
          keyByRow={keyByRow}
        />
      ))}
    </box>
  );
}

function GroupBranchView({
  columns,
  branch,
  layoutByItem,
  keyByRow,
}: {
  columns: number;
  branch: DashboardTreeBranch;
  layoutByItem: ReadonlyMap<string, RowGridLayout>;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const row = branch.row;
  if (row.payload.type !== "groupHeader") return null;
  const renderableId = `station-dashboard-group:${row.id}`;
  const header = (
    <GroupHeaderView
      renderableId={semanticItemRenderableId(row.id)}
      columns={row.payload.collapsed ? columns : groupFrameContentColumns(columns)}
      rowId={row.id}
      payload={row.payload}
      cells={row.cells}
      focusedCellId={row.focusedCellId}
    />
  );
  if (row.payload.collapsed) {
    return (
      <box id={renderableId} flexDirection="column" width="100%">
        {header}
      </box>
    );
  }
  return (
    <GroupFrameView
      renderableId={renderableId}
      focus={{
        focusedHeader: row.focusedCellId !== undefined,
        containsFocusedRow: row.containsFocusedRow === true,
      }}
    >
      {header}
      {branch.children.map((child) => (
        <DashboardBranchView
          key={child.row.id}
          columns={columns}
          branch={child}
          layoutByItem={layoutByItem}
          keyByRow={keyByRow}
        />
      ))}
    </GroupFrameView>
  );
}

function DashboardLeaf({
  row,
  layout,
  keyByRow,
}: {
  row: DashboardTreeRow;
  layout: RowGridLayout | undefined;
  keyByRow: ReadonlyMap<string, string>;
}) {
  const theme = useStationTheme();
  switch (row.payload.type) {
    case "emptyProject":
      return (
        <box id={semanticItemRenderableId(row.id)} flexDirection="row">
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
          slot={keyByRow.get(row.payload.row.id)}
          focused={row.focusedCellId === "identity"}
        />
      );
    case "createLocalRow": {
      // Local create rows have no slot and no activation target.
      if (layout === undefined) return null;
      return (
        <box
          id={semanticItemRenderableId(row.id)}
          flexDirection="column"
          width="100%"
        >
          <text fg={toOpenTuiColor(theme.text.primary)}>
            <Segments segments={layout.segments} />
          </text>
          {row.payload.row.status === "failed" ? (
            <text fg={toOpenTuiColor(theme.status.danger)}>{row.payload.row.error.message}</text>
          ) : null}
        </box>
      );
    }
    case "projectHeader":
    case "groupHeader":
      return null;
  }
}

const SessionRowLine = memo(function SessionRowLine({
  rowId,
  layout,
  slot,
  focused,
}: {
  rowId: DashboardRowId;
  layout: RowGridLayout;
  slot: string | undefined;
  focused?: boolean;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const visibleLayout = useMemo(
    () => withRowGridSelectionSlot(layout, slot),
    [layout, slot],
  );
  // Persistent cursor fill sits under the transient hover fill.
  const background = hover
    ? { backgroundColor: toOpenTuiColor(theme.interaction.hover) }
    : focused === true
      ? { backgroundColor: toOpenTuiColor(theme.interaction.keyboardFocus) }
      : {};
  // Compact row-grid presentation is an intentional single-cell-high leaf layout.
  return (
    <box
      id={semanticItemRenderableId(rowId)}
      flexDirection="row"
      height={1}
      width="100%"
      {...background}
    >
      <box
        flexGrow={1}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <text
          width="100%"
          fg={toOpenTuiColor(theme.text.primary)}
          {...stationMouseProps(dispatch, { kind: "dashboardCell", rowId, cellId: "identity" })}
        >
          <Segments segments={visibleLayout.segments} />
        </text>
        <SegmentLinkTargets segments={visibleLayout.segments} />
      </box>
    </box>
  );
});

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

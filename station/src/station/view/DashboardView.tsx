import { TextAttributes } from "@opentui/core";
import {
  dashboardRowIds,
  dashboardTableHeaderModel,
  fleetCountsLabel,
  FIRST_RUN_BODY_LABEL,
  selectFleetSummary,
  type DashboardSlots,
  type DashboardTreeProjection,
  type FleetSummary,
  type RowGridLayout,
} from "@station/dashboard-core/selectors";
import { cellWidth, truncateCells } from "@station/dashboard-core/text";
import type {
  DashboardScreenView,
  DashboardSnapshotView,
  DashboardViewState,
} from "@station/dashboard-core/state";
import { DashboardTableHeaderView } from "./DashboardTableHeaderView.js";
import { Throbber } from "./Throbber.js";
import { FLEET_STATUS_ORDER, STATION_STATUS_UI } from "../statusUi.js";
import { toOpenTuiColor, useStationTheme } from "../../theme/index.js";
import {
  StationHoverProvider,
  useStationHoverState,
  useStationMouse,
  stationMouseProps,
} from "./stationMouseContext.js";
import { useLayoutEffect, useMemo } from "react";
import { DashboardTreeView } from "./dashboard/DashboardTreeView.js";
import { DashboardScrollViewport } from "./layout/scroll/DashboardScrollViewport.js";
import { semanticItemRenderableId } from "./layout/scroll/scrollViewport.js";
import type { DashboardScrollController } from "./layout/scroll/dashboardScrollController.js";
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
  tree: DashboardTreeProjection;
  slots: DashboardSlots;
  columns: number;
  menuHoverEnabled: boolean;
};

export function DashboardView({
  snapshot,
  viewState,
  screen,
  layout,
  tree,
  slots,
  columns,
  menuHoverEnabled,
}: DashboardViewProps) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
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
    hasSemanticRowsAbove: slots.semanticOverflow.above,
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
          // The elevated header must own click-away because it sits above the screen backdrop.
          {...(conditionPanelActive
            ? stationMouseProps(dispatch, { kind: "screenBackdrop" })
            : {})}
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
          <DashboardTreeView
            columns={contentColumns}
            roots={tree.roots}
            layoutByItem={layoutByItem}
            keyByRow={keyByRow}
          />
        </DashboardScrollViewport>
      )}
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

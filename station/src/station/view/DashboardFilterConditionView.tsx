import { TextAttributes, type ColorInput } from "@opentui/core";
import { dashboardFilterConditionPanelModel } from "@station/dashboard-core/selectors";
import { cellWidth, truncateCells } from "@station/dashboard-core/text";
import type { DashboardFilterConditionPanelAction, DashboardFilterConditionPanelRow } from "@station/dashboard-core/selectors";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationColor,
  type StationTheme,
} from "../../theme/index.js";
import { stationAgentStatusTone } from "../statusUi.js";
import { filterConditionFrame } from "./layout/filterConditionFrame.js";
import { SemanticScrollRegion } from "./layout/SemanticScrollViewport.js";
import { semanticItemRenderableId } from "./layout/scrollViewport.js";
import { useAncestorBoundedHeight } from "./layout/useAncestorBoundedHeight.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";

export const FILTER_CONDITION_PANEL_ID = "station-filter-condition-panel";
const FILTER_CONDITION_VIEWPORT_ID = "station-filter-condition-viewport";

export function DashboardFilterConditionView({
  screen,
  columns,
  boundaryId,
}: {
  screen: Extract<DashboardScreenView, { name: "persistentFilter" }>;
  columns: number;
  boundaryId: string;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const model = dashboardFilterConditionPanelModel({ screen });
  const contentIdentity =
    model === undefined
      ? "absent"
      : `${model.title}\u0000${model.rows.map((row) => row.id).join("\u0000")}\u0000${model.actions
          .map((action) => action.id)
          .join("\u0000")}`;
  const panelRef = useAncestorBoundedHeight(
    boundaryId,
    FILTER_CONDITION_VIEWPORT_ID,
    contentIdentity,
  );
  if (model === undefined) return null;
  const background = toOpenTuiOpaqueColor(theme.filter.conditionSurface);
  const frame = filterConditionFrame(columns, model.rows.map((row) => row.label));
  const followedRowId = model.rows.find((row) => row.marker === "▸")?.id;
  return (
    <box
      id={FILTER_CONDITION_PANEL_ID}
      ref={panelRef}
      width={frame.width}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.filter.editorRail)}
      backgroundColor={background}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <ConditionPanelHeader model={model} width={frame.innerWidth} background={background} />
      <SemanticScrollRegion
        itemIds={model.rows.map((row) => row.id)}
        followedItemId={followedRowId}
        fill={false}
        viewportId={FILTER_CONDITION_VIEWPORT_ID}
      >
        {model.emptyMessage === undefined ? (
          model.rows.map((row) => (
            <ConditionPanelRow
              key={row.id}
              row={row}
              width={frame.innerWidth}
              background={background}
            />
          ))
        ) : (
          <text
            width="100%"
            flexShrink={0}
            fg={toOpenTuiColor(theme.text.muted)}
            bg={background}
            selectable={false}
          >
            {fitConditionLine(`  ${model.emptyMessage}`, frame.innerWidth)}
          </text>
        )}
      </SemanticScrollRegion>
      <ConditionPanelActions actions={model.actions} background={background} />
    </box>
  );
}

function ConditionPanelRow({
  row,
  width,
  background,
}: {
  row: DashboardFilterConditionPanelRow;
  width: number;
  background: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const selectedBackground = toOpenTuiOpaqueColor(theme.filter.conditionSelected);
  const rowBackground = hover || row.marker === "▸" ? selectedBackground : background;
  const target =
    row.kind === "field"
      ? { kind: "persistentFilterConditionField" as const, field: row.field }
      : {
          kind: "persistentFilterConditionValue" as const,
          field: row.field,
          valueId: row.valueId,
        };
  const mouseProps = stationMouseProps(dispatch, target);
  if (row.kind === "field") {
    const marker = `${row.marker} `;
    const hotkey = `${row.key} `;
    const prefixWidth = cellWidth(marker) + cellWidth(hotkey);
    const chevron = " ›";
    const label = truncateCells(row.label, Math.max(1, width - prefixWidth - 5));
    const summaryBudget = Math.max(
      0,
      width - prefixWidth - cellWidth(label) - cellWidth(chevron) - 1,
    );
    const summary = fitConditionFieldSummary(row, summaryBudget);
    const padding = " ".repeat(
      Math.max(
        0,
        width - prefixWidth - cellWidth(label) - cellWidth(summary) - cellWidth(chevron),
      ),
    );
    return (
      <text
        id={semanticItemRenderableId(row.id)}
        width="100%"
        flexShrink={0}
        fg={toOpenTuiColor(theme.text.primary)}
        bg={rowBackground}
        selectable={false}
        {...mouseProps}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <span attributes={row.marker === "▸" ? TextAttributes.BOLD : TextAttributes.NONE}>
          {marker}
        </span>
        <span fg={toOpenTuiColor(theme.action.warning)} attributes={TextAttributes.BOLD}>
          {hotkey}
        </span>
        <span fg={toOpenTuiColor(conditionRowForeground(theme, row))}>{label}</span>
        {padding}
        <span fg={toOpenTuiColor(theme.text.muted)}>{summary}</span>
        <span fg={toOpenTuiColor(theme.filter.editorRail)}>{chevron}</span>
      </text>
    );
  }
  const prefix = `${row.marker} ${row.key} [${row.checked ? "✓" : " "}] `;
  const label = truncateCells(row.label, Math.max(1, width - cellWidth(prefix)));
  const padding = " ".repeat(Math.max(0, width - cellWidth(prefix) - cellWidth(label)));
  return (
    <text
      id={semanticItemRenderableId(row.id)}
      width="100%"
      flexShrink={0}
      fg={toOpenTuiColor(theme.text.primary)}
      bg={rowBackground}
      selectable={false}
      {...mouseProps}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <span attributes={row.marker === "▸" ? TextAttributes.BOLD : TextAttributes.NONE}>
        {row.marker} {row.key}{" "}
      </span>
      <span fg={toOpenTuiColor(row.checked ? theme.filter.editorRail : theme.text.muted)}>
        [{row.checked ? "✓" : " "}]{" "}
      </span>
      <span fg={toOpenTuiColor(conditionRowForeground(theme, row))}>{label}</span>
      {padding}
    </text>
  );
}

function ConditionPanelHeader({
  model,
  width,
  background,
}: {
  model: { title: string; actions: readonly DashboardFilterConditionPanelAction[] };
  width: number;
  background: ColorInput;
}) {
  const theme = useStationTheme();
  const back = model.actions.find(
    (action): action is Extract<DashboardFilterConditionPanelAction, { id: "back" | "close" }> =>
      action.id === "back",
  );
  const close = model.actions.find(
    (action): action is Extract<DashboardFilterConditionPanelAction, { id: "back" | "close" }> =>
      action.id === "close",
  );
  const actionWidth = (back === undefined ? 0 : 3) + (close === undefined ? 0 : 3);
  const titleWidth = Math.max(1, width - actionWidth);
  return (
    <box width="100%" flexDirection="row" backgroundColor={background} flexShrink={0}>
      {back === undefined ? null : (
        <ConditionPanelHeaderAction action={back} background={background} />
      )}
      <text
        width={titleWidth}
        fg={toOpenTuiColor(theme.text.primary)}
        bg={background}
        selectable={false}
        attributes={TextAttributes.BOLD}
      >
        {fitConditionLine(conditionPanelTitle(model), titleWidth)}
      </text>
      {close === undefined ? null : (
        <ConditionPanelHeaderAction action={close} background={background} />
      )}
    </box>
  );
}

function ConditionPanelHeaderAction({
  action,
  background,
}: {
  action: Extract<DashboardFilterConditionPanelAction, { id: "back" | "close" }>;
  background: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  return (
    <text
      width={3}
      fg={toOpenTuiColor(theme.filter.editorRail)}
      bg={hover ? toOpenTuiOpaqueColor(theme.filter.conditionSelected) : background}
      selectable={false}
      attributes={TextAttributes.BOLD}
      {...stationMouseProps(dispatch, {
        kind: "persistentFilterConditionAction",
        actionId: action.id,
      })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      [{action.label}]
    </text>
  );
}

function ConditionPanelActions({
  actions,
  background,
}: {
  actions: readonly DashboardFilterConditionPanelAction[];
  background: ColorInput;
}) {
  const action = actions.find(
    (
      candidate,
    ): candidate is Extract<
      DashboardFilterConditionPanelAction,
      { id: "done" | "applyFilter" }
    > => candidate.placement === "footer",
  );
  if (action === undefined) return null;
  return (
    <box
      width="100%"
      flexShrink={0}
      marginTop={action.id === "applyFilter" ? 1 : 0}
      backgroundColor={background}
    >
      <ConditionPanelFooterAction action={action} background={background} />
    </box>
  );
}

function ConditionPanelFooterAction({
  action,
  background,
}: {
  action: Extract<DashboardFilterConditionPanelAction, { id: "done" | "applyFilter" }>;
  background: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const selected = hover || action.focused;
  return (
    <text
      width="100%"
      fg={toOpenTuiColor(theme.text.primary)}
      bg={selected ? toOpenTuiOpaqueColor(theme.filter.conditionSelected) : background}
      selectable={false}
      {...stationMouseProps(dispatch, {
        kind: "persistentFilterConditionAction",
        actionId: action.id,
      })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <span
        fg={toOpenTuiColor(action.focused ? theme.filter.editorRail : theme.text.primary)}
        attributes={action.focused ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {action.focused ? "▸ " : "  "}
        {action.label}
      </span>
      <span fg={toOpenTuiColor(theme.action.warning)} attributes={TextAttributes.BOLD}>
        {` (${action.shortcut})`}
      </span>
    </text>
  );
}

function fitConditionFieldSummary(
  row: Extract<DashboardFilterConditionPanelRow, { kind: "field" }>,
  width: number,
): string {
  if (width <= 0) return "";
  if (cellWidth(row.summary) <= width) return row.summary;
  if (row.selectionCount > 1) return truncateCells(String(row.selectionCount), width);
  return truncateCells(row.summary, width);
}

function conditionPanelTitle(model: { title: string }): string {
  return ` ${model.title}`;
}

function conditionRowForeground(
  theme: StationTheme,
  row: DashboardFilterConditionPanelRow,
): StationColor {
  if (row.kind === "field") return theme.text.primary;
  if (row.field === "project") return theme.action.primary;
  if (row.field === "agent") return theme.status.accent;
  return theme.status[stationAgentStatusTone(row.valueId)];
}

function fitConditionLine(value: string, width: number): string {
  const visible = truncateCells(value, width);
  return `${visible}${" ".repeat(Math.max(0, width - cellWidth(visible)))}`;
}

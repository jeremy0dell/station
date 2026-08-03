import { TextAttributes, type ColorInput } from "@opentui/core";
import {
  cellWidth,
  dashboardFilterConditionPanelModel,
  truncateCells,
  type DashboardFilterConditionPanelAction,
  type DashboardFilterConditionPanelRow,
  type TuiScreen,
} from "@station/dashboard-core";
import {
  toOpenTuiColor,
  toOpenTuiOpaqueColor,
  useStationTheme,
  type StationColor,
  type StationTheme,
} from "../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "./stationMouseContext.js";

export function DashboardFilterConditionView({
  screen,
  columns,
  availableRows,
  top,
}: {
  screen: Extract<TuiScreen, { name: "persistentFilter" }>;
  columns: number;
  availableRows: number;
  top: number;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const model = dashboardFilterConditionPanelModel({ screen, columns, availableRows });
  if (model === undefined) return null;
  const background = toOpenTuiOpaqueColor(theme.filter.conditionSurface);
  const innerWidth = Math.max(1, model.width - 2);
  return (
    <box
      position="absolute"
      top={top}
      left={0}
      width={model.width}
      height={model.height}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.filter.editorRail)}
      backgroundColor={background}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text
        width="100%"
        fg={toOpenTuiColor(theme.text.primary)}
        bg={background}
        attributes={TextAttributes.BOLD}
      >
        {fitConditionLine(conditionPanelTitle(model), innerWidth)}
      </text>
      {model.emptyMessage === undefined ? (
        model.rows.map((row) => (
          <ConditionPanelRow key={row.id} row={row} width={innerWidth} background={background} />
        ))
      ) : (
        <text width="100%" fg={toOpenTuiColor(theme.text.muted)} bg={background}>
          {fitConditionLine(`  ${model.emptyMessage}`, innerWidth)}
        </text>
      )}
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
        width="100%"
        fg={toOpenTuiColor(theme.text.primary)}
        bg={rowBackground}
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
      width="100%"
      fg={toOpenTuiColor(theme.text.primary)}
      bg={rowBackground}
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

function ConditionPanelActions({
  actions,
  background,
}: {
  actions: readonly DashboardFilterConditionPanelAction[];
  background: ColorInput;
}) {
  const back = actions.find((action) => action.id === "back");
  const apply = actions.find((action) => action.id === "apply");
  if (back === undefined || apply === undefined) return null;
  return (
    <box width="100%" height={1} flexDirection="row" backgroundColor={background}>
      <ConditionPanelAction action={back} background={background} />
      <box flexGrow={1} height={1} backgroundColor={background} />
      <ConditionPanelAction action={apply} background={background} />
    </box>
  );
}

function ConditionPanelAction({
  action,
  background,
}: {
  action: DashboardFilterConditionPanelAction;
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

function fitConditionFieldSummary(
  row: Extract<DashboardFilterConditionPanelRow, { kind: "field" }>,
  width: number,
): string {
  if (width <= 0) return "";
  if (cellWidth(row.summary) <= width) return row.summary;
  if (row.selectionCount > 1) return truncateCells(String(row.selectionCount), width);
  return truncateCells(row.summary, width);
}

function conditionPanelTitle(model: {
  title: string;
  hiddenAbove: number;
  hiddenBelow: number;
}): string {
  const above = model.hiddenAbove > 0 ? ` ↑${model.hiddenAbove}` : "";
  const below = model.hiddenBelow > 0 ? ` ↓${model.hiddenBelow}` : "";
  return ` ${model.title}${above}${below}`;
}

function conditionRowForeground(
  theme: StationTheme,
  row: DashboardFilterConditionPanelRow,
): StationColor {
  if (row.kind === "field") return theme.text.primary;
  if (row.field === "project") return theme.action.primary;
  if (row.field === "agent") return theme.status.accent;
  switch (row.valueId) {
    case "needs_attention":
    case "stuck":
      return theme.status.danger;
    case "working":
    case "starting":
      return theme.status.working;
    case "idle":
      return theme.status.success;
    case "unknown":
      return theme.status.warning;
    default:
      return theme.status.neutral;
  }
}

function fitConditionLine(value: string, width: number): string {
  const visible = truncateCells(value, width);
  return `${visible}${" ".repeat(Math.max(0, width - cellWidth(visible)))}`;
}

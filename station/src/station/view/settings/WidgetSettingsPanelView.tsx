import { TextAttributes, type ColorInput } from "@opentui/core";
import type {
  DashboardScreenView,
  DashboardStateView,
  WidgetSettingsFocus,
} from "@station/dashboard-core";
import {
  widgetSettingsPanelLayout,
  widgetSettingsPanelModel,
  type WidgetSettingsLine,
} from "@station/dashboard-core";
import { fit } from "../sheets/parts.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../../theme/index.js";
import {
  stationMouseProps,
  useStationHoverState,
  useStationMouse,
} from "../stationMouseContext.js";

const UNSELECTABLE_TEXT = { selectable: false } as const;

export type WidgetSettingsPanelViewProps = {
  screen: Extract<DashboardScreenView, { name: "widgetSettings" }>;
  widgets: DashboardStateView["widgets"];
  widgetsPersisted: boolean;
  columns: number;
  rows: number;
};

export function WidgetSettingsPanelView({
  screen,
  widgets,
  widgetsPersisted,
  columns,
  rows,
}: WidgetSettingsPanelViewProps) {
  const theme = useStationTheme();
  const surfaceBackground = toOpenTuiOpaqueColor(theme.surfaces.settings);
  const dispatch = useStationMouse();
  const model = widgetSettingsPanelModel(screen, widgets, widgetsPersisted);
  const { top, left, width, height, innerWidth } = widgetSettingsPanelLayout(
    columns,
    rows,
    model.lines.length,
  );
  return (
    <box
      position="absolute"
      top={top}
      left={left}
      width={width}
      height={height}
      zIndex={10}
      border
      borderColor={toOpenTuiColor(theme.interaction.hairline)}
      backgroundColor={surfaceBackground}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text
        fg={toOpenTuiColor(theme.text.primary)}
        bg={surfaceBackground}
        attributes={TextAttributes.BOLD}
        {...UNSELECTABLE_TEXT}
      >
        {fit(` ${model.title}`, innerWidth)}
      </text>
      <text fg={toOpenTuiColor(theme.text.muted)} bg={surfaceBackground} {...UNSELECTABLE_TEXT}>
        {fit(` ${model.note}`, innerWidth)}
      </text>
      {model.lines.map((line) => (
        <PanelLine
          key={lineKey(line)}
          line={line}
          width={innerWidth}
          focus={model.focus}
          surfaceBackground={surfaceBackground}
        />
      ))}
      <text
        fg={toOpenTuiColor(theme.text.primary)}
        bg={surfaceBackground}
        attributes={TextAttributes.DIM}
        {...UNSELECTABLE_TEXT}
      >
        {fit(` ${model.footer}`, innerWidth)}
      </text>
    </box>
  );
}

function lineKey(line: WidgetSettingsLine): string {
  if (line.kind === "widget") {
    return `widget:${line.index}`;
  }
  if (line.kind === "pickerChoice") {
    return `pick:${line.index}`;
  }
  return line.kind;
}

function PanelLine({
  line,
  width,
  focus,
  surfaceBackground,
}: {
  line: WidgetSettingsLine;
  width: number;
  focus: WidgetSettingsFocus;
  surfaceBackground: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  if (line.kind === "empty") {
    return (
      <text fg={toOpenTuiColor(theme.text.muted)} bg={surfaceBackground} {...UNSELECTABLE_TEXT}>
        {fit(`   ${line.label}`, width)}
      </text>
    );
  }
  if (line.kind === "add") {
    return (
      <text
        fg={toOpenTuiColor(theme.action.primary)}
        bg={hover ? toOpenTuiColor(theme.interaction.hover) : surfaceBackground}
        {...UNSELECTABLE_TEXT}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsAdd" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(`   ${line.label}`, width)}
      </text>
    );
  }
  if (line.kind === "pickerChoice") {
    let background: ColorInput = surfaceBackground;
    if (line.active) {
      background = toOpenTuiColor(theme.interaction.keyboardFocus);
    }
    if (hover) {
      background = toOpenTuiColor(theme.interaction.hover);
    }
    return (
      <text
        fg={toOpenTuiColor(line.active ? theme.action.primary : theme.text.primary)}
        bg={background}
        {...UNSELECTABLE_TEXT}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsPickerChoice", index: line.index })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(` ${line.active ? "▸" : " "} ${line.label}`, width)}
      </text>
    );
  }
  // The list dims behind the picker so the active surface is unambiguous.
  const dimmed = focus === "picker";
  const chip = line.enabled ? "[on ]" : "[off]";
  const marker = line.active && !dimmed ? "▸" : " ";
  let rowColor: ColorInput = toOpenTuiColor(theme.text.muted);
  if (!dimmed && line.active) {
    rowColor = toOpenTuiColor(theme.action.primary);
  } else if (!dimmed && line.enabled) {
    rowColor = toOpenTuiColor(theme.text.primary);
  }
  return (
    <box flexDirection="row">
      <text
        fg={rowColor}
        bg={hover && !dimmed ? toOpenTuiColor(theme.interaction.hover) : surfaceBackground}
        {...UNSELECTABLE_TEXT}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsRow", index: line.index })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(` ${marker} ${chip} ${line.label}`, width - 2)}
      </text>
      <RemoveMark
        index={line.index}
        rowHovered={hover && !dimmed}
        surfaceBackground={surfaceBackground}
      />
    </box>
  );
}

// Its own element so the click hits only the remove action, never row-toggle.
function RemoveMark({
  index,
  rowHovered,
  surfaceBackground,
}: {
  index: number;
  rowHovered: boolean;
  surfaceBackground: ColorInput;
}) {
  const theme = useStationTheme();
  const dispatch = useStationMouse();
  const [hover, setHover] = useStationHoverState();
  const color = hover
    ? theme.status.danger
    : rowHovered
      ? theme.text.muted
      : theme.interaction.hairline;
  return (
    <text
      fg={toOpenTuiColor(color)}
      bg={surfaceBackground}
      {...UNSELECTABLE_TEXT}
      {...stationMouseProps(dispatch, { kind: "widgetSettingsRemove", index })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {"× "}
    </text>
  );
}

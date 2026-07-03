import { TextAttributes } from "@opentui/core";
import { useState } from "react";
import type { WidgetSettingsFocus } from "@station/dashboard-core";
import {
  widgetSettingsPanelLayout,
  widgetSettingsPanelModel,
  type TuiScreen,
  type WidgetSettingsLine,
} from "@station/dashboard-core";
import type { TuiWidgetConfig } from "@station/dashboard-core/widgets/types";
import { fit } from "../sheets/parts.js";
import { STATION_COLORS } from "../theme.js";
import { stationMouseProps, useStationMouse } from "../stationMouseContext.js";

export type WidgetSettingsPanelViewProps = {
  screen: Extract<TuiScreen, { name: "widgetSettings" }>;
  widgets: readonly TuiWidgetConfig[];
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
      borderColor={STATION_COLORS.hairline}
      backgroundColor={STATION_COLORS.background}
      flexDirection="column"
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      <text fg={STATION_COLORS.foreground} bg={STATION_COLORS.background} attributes={TextAttributes.BOLD}>
        {fit(` ${model.title}`, innerWidth)}
      </text>
      <text fg={STATION_COLORS.gray} bg={STATION_COLORS.background}>
        {fit(` ${model.note}`, innerWidth)}
      </text>
      {model.lines.map((line) => (
        <PanelLine
          key={lineKey(line)}
          line={line}
          width={innerWidth}
          focus={model.focus}
        />
      ))}
      <text
        fg={STATION_COLORS.foreground}
        bg={STATION_COLORS.background}
        attributes={TextAttributes.DIM}
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
}: {
  line: WidgetSettingsLine;
  width: number;
  focus: WidgetSettingsFocus;
}) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  if (line.kind === "empty") {
    return (
      <text fg={STATION_COLORS.gray} bg={STATION_COLORS.background}>
        {fit(`   ${line.label}`, width)}
      </text>
    );
  }
  if (line.kind === "add") {
    return (
      <text
        fg={STATION_COLORS.cyan}
        bg={hover ? STATION_COLORS.hoverBackground : STATION_COLORS.background}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsAdd" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(`   ${line.label}`, width)}
      </text>
    );
  }
  if (line.kind === "pickerChoice") {
    let background: string = STATION_COLORS.background;
    if (line.active) {
      background = STATION_COLORS.focusBackground;
    }
    if (hover) {
      background = STATION_COLORS.hoverBackground;
    }
    return (
      <text
        fg={line.active ? STATION_COLORS.cyan : STATION_COLORS.foreground}
        bg={background}
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
  let rowColor: string = STATION_COLORS.gray;
  if (!dimmed && line.active) {
    rowColor = STATION_COLORS.cyan;
  } else if (!dimmed && line.enabled) {
    rowColor = STATION_COLORS.foreground;
  }
  return (
    <box flexDirection="row">
      <text
        fg={rowColor}
        bg={hover && !dimmed ? STATION_COLORS.hoverBackground : STATION_COLORS.background}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsRow", index: line.index })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(` ${marker} ${chip} ${line.label}`, width - 2)}
      </text>
      <RemoveMark index={line.index} rowHovered={hover && !dimmed} />
    </box>
  );
}

// Its own element so the click hits only the remove action, never row-toggle.
function RemoveMark({ index, rowHovered }: { index: number; rowHovered: boolean }) {
  const dispatch = useStationMouse();
  const [hover, setHover] = useState(false);
  return (
    <text
      fg={hover ? STATION_COLORS.red : rowHovered ? STATION_COLORS.gray : STATION_COLORS.hairline}
      bg={STATION_COLORS.background}
      {...stationMouseProps(dispatch, { kind: "widgetSettingsRemove", index })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {"× "}
    </text>
  );
}

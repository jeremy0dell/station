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
  columns: number;
  rows: number;
};

export function WidgetSettingsPanelView({
  screen,
  widgets,
  columns,
  rows,
}: WidgetSettingsPanelViewProps) {
  const dispatch = useStationMouse();
  const model = widgetSettingsPanelModel(screen, widgets);
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
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.BOLD}>
        {fit(` ${model.title}`, innerWidth)}
      </text>
      <text fg={STATION_COLORS.gray}>{fit(` ${model.note}`, innerWidth)}</text>
      {model.lines.map((line) => (
        <PanelLine
          key={lineKey(line)}
          line={line}
          width={innerWidth}
          focus={model.focus}
        />
      ))}
      <text fg={STATION_COLORS.foreground} attributes={TextAttributes.DIM}>
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
    return <text fg={STATION_COLORS.gray}>{fit(`   ${line.label}`, width)}</text>;
  }
  if (line.kind === "add") {
    return (
      <text
        fg={STATION_COLORS.cyan}
        {...(hover ? { bg: STATION_COLORS.hoverBackground } : {})}
        {...stationMouseProps(dispatch, { kind: "widgetSettingsAdd" })}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        {fit(`   ${line.label}`, width)}
      </text>
    );
  }
  if (line.kind === "pickerChoice") {
    return (
      <text
        fg={line.active ? STATION_COLORS.cyan : STATION_COLORS.foreground}
        {...(hover ? { bg: STATION_COLORS.hoverBackground } : {})}
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
  const rowColor = dimmed
    ? STATION_COLORS.gray
    : line.active
      ? STATION_COLORS.cyan
      : line.enabled
        ? STATION_COLORS.foreground
        : STATION_COLORS.gray;
  return (
    <box flexDirection="row">
      <text
        fg={rowColor}
        {...(hover && !dimmed ? { bg: STATION_COLORS.hoverBackground } : {})}
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
      {...stationMouseProps(dispatch, { kind: "widgetSettingsRemove", index })}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      {"× "}
    </text>
  );
}

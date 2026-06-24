// OpenTUI port of apps/tui's HelpOverlay: centered box-drawn panel above the
// dashboard (absolute + zIndex; the dashboard must never reflow for it).
// Lines come from the shared panel generator over the keymap's help content.
import { STATION_HELP_CONTENT } from "../input/stationKeymap.js";
import { helpPanelLayout, helpPanelLines } from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export function HelpOverlayView({ columns, rows }: { columns: number; rows: number }) {
  const dispatch = useStationMouse();
  const layout = helpPanelLayout(columns, rows, STATION_HELP_CONTENT);
  const panelLines = helpPanelLines(layout.width, layout.height, STATION_HELP_CONTENT);

  return (
    <box
      position="absolute"
      top={layout.top}
      left={layout.left}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      flexDirection="column"
      backgroundColor={STATION_COLORS.overlayBackdrop}
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      {panelLines.map((line, index) => (
        <text key={`${index}:${line}`} fg={STATION_COLORS.foreground} bg={STATION_COLORS.overlayBackdrop}>
          {line}
        </text>
      ))}
    </box>
  );
}

// OpenTUI port of apps/tui's HelpOverlay: centered box-drawn panel above the
// dashboard (absolute + zIndex; the dashboard must never reflow for it).
// Lines come from the shared panel generator over Station's visible help copy.
import {
  helpOverlayContent,
  helpPanelLayout,
  helpPanelModel,
} from "@station/dashboard-core/selectors";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { stationKeymapHelp } from "../../input/keymap/stationBindings.js";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

export function HelpOverlayView({
  screen,
  columns,
  rows,
}: {
  screen: Extract<DashboardScreenView, { name: "help" }>;
  columns: number;
  rows: number;
}) {
  const theme = useStationTheme();
  const helpBackground = toOpenTuiOpaqueColor(theme.surfaces.help);
  const dispatch = useStationMouse();
  const content = helpOverlayContent(stationKeymapHelp());
  const layout = helpPanelLayout(columns, rows, content);
  const model = helpPanelModel(layout.width, layout.height, content, screen.scrollOffset);
  const fg = toOpenTuiColor(theme.text.primary);
  const barFg = toOpenTuiColor(theme.text.muted);

  return (
    <box
      position="absolute"
      top={layout.top}
      left={layout.left}
      width={layout.width}
      height={layout.height}
      zIndex={10}
      flexDirection="column"
      backgroundColor={helpBackground}
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      {model.lines.map((line, index) =>
        line.kind === "border" ? (
          <text key={`${index}:${line.text}`} fg={fg} bg={helpBackground}>
            {line.text}
          </text>
        ) : (
          <box key={`${index}:${line.prefix}`} flexDirection="row" height={1}>
            <text fg={fg} bg={helpBackground}>
              {line.prefix}
            </text>
            {line.bar === "" ? null : (
              <text
                fg={barFg}
                bg={helpBackground}
                {...(model.overflow
                  ? stationMouseProps(dispatch, {
                      kind: "scrollbar",
                      surface: "help",
                      offset: line.offset,
                    })
                  : {})}
              >
                {line.bar}
              </text>
            )}
            <text fg={fg} bg={helpBackground}>
              {line.suffix}
            </text>
          </box>
        ),
      )}
    </box>
  );
}

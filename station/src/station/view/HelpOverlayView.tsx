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
import { StationScrollbar } from "./StationScrollbar.js";
import {
  useStationMouse,
  stationMouseProps,
} from "./stationMouseContext.js";

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
  const body = model.lines.flatMap((line) => (line.kind === "body" ? [line] : []));
  const top = model.lines[0];
  const bottom = model.lines.at(-1);
  const barColumn = body[0]?.bar.length === 1;

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
      selectable={false}
      {...stationMouseProps(dispatch, { kind: "sheetBackdrop" })}
    >
      {top?.kind === "border" ? (
        <text fg={fg} bg={helpBackground} selectable={false}>
          {top.text}
        </text>
      ) : null}
      {model.bodyRows > 0 ? (
        <box flexDirection="row" height={model.bodyRows}>
          <box flexDirection="column" flexShrink={0}>
            {body.map((line, index) => (
              <text key={`prefix:${index}`} fg={fg} bg={helpBackground} selectable={false}>
                {line.prefix}
              </text>
            ))}
          </box>
          {barColumn ? (
            <StationScrollbar
              surface="help"
              contentLength={content.length}
              viewportLength={model.bodyRows}
              trackHeight={model.bodyRows}
              offset={screen.scrollOffset}
            />
          ) : null}
          <box flexDirection="column" width={1} flexShrink={0}>
            {body.map((line, index) => (
              <text key={`suffix:${index}`} fg={fg} bg={helpBackground} selectable={false}>
                {line.suffix}
              </text>
            ))}
          </box>
        </box>
      ) : null}
      {bottom?.kind === "border" && model.lines.length > 1 ? (
        <text fg={fg} bg={helpBackground} selectable={false}>
          {bottom.text}
        </text>
      ) : null}
    </box>
  );
}

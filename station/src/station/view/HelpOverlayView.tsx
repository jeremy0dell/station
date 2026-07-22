// OpenTUI port of apps/tui's HelpOverlay: centered box-drawn panel above the
// dashboard (absolute + zIndex; the dashboard must never reflow for it).
// Lines come from the shared panel generator over Station's visible help copy.
import { helpPanelLayout, helpPanelLines } from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";
import { useStationMouse, stationMouseProps } from "./stationMouseContext.js";

const STATION_HELP_CONTENT = [
  { text: "station help", align: "center" as const },
  { text: "" },
  { key: "Ctrl-O", description: "open/close project view" },
  { key: "Ctrl-Q", description: "quit Station" },
  { key: "Ctrl-\\", description: "split pane right" },
  { key: "Ctrl-^", description: "split pane below (Ctrl-6)" },
  { key: "Ctrl-]", description: "focus next pane" },
  { key: "Ctrl-/", description: "close split pane (Ctrl-_)" },
  { key: "Enter/Sp", description: "open project view on welcome" },
  { key: "Esc/↑↓", description: "context menu close/move" },
  { key: "Enter/Sp", description: "context menu select" },
  { text: "station project view", align: "center" as const },
  { key: "↑/↓", description: "move cursor" },
  { key: "↵", description: "open focused session" },
  { key: "tab", description: "next session needing you" },
  { key: "wheel", description: "scroll project list" },
  { key: "1-9/a-z", description: "open visible session" },
  { key: "N/A/R/C/F/P", description: "new/add/rename/fold/fork/settings" },
  { key: "W", description: "widgets" },
  { key: "X", description: "delete session" },
  { key: "/, Z", description: "search / refresh snapshot" },
  { key: "H/?", description: "help" },
  { key: "Q/Esc", description: "close/back/cancel" },
] as const;

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

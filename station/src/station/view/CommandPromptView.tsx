// Legacy prompt renderer for search and existing chooser copy; persistent
// filtering owns the dashboard header and never enters this absolute layer.
import { commandPromptLineForScreen, type TuiScreen } from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";

export function CommandPromptView({ screen }: { screen: TuiScreen }) {
  const line = commandPromptLineForScreen(screen);
  if (line === undefined) {
    return null;
  }
  return (
    <box position="absolute" left={0} right={0} bottom={3} zIndex={5} flexDirection="column">
      <text
        fg={line.color === "red" ? STATION_COLORS.red : STATION_COLORS.yellow}
        bg={STATION_COLORS.background}
      >
        {line.text}
      </text>
    </box>
  );
}

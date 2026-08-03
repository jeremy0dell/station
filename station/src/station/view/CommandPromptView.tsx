// Legacy prompt renderer for search and existing chooser copy; persistent
// filtering owns the dashboard header and never enters this absolute layer.
import {
  commandPromptLineForScreen,
  type DashboardScreenView,
} from "@station/dashboard-core";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";

export function CommandPromptView({ screen }: { screen: DashboardScreenView }) {
  const theme = useStationTheme();
  const line = commandPromptLineForScreen(screen);
  if (line === undefined) {
    return null;
  }
  return (
    <box position="absolute" left={0} right={0} bottom={3} zIndex={5} flexDirection="column">
      <text
        fg={toOpenTuiColor(line.color === "red" ? theme.status.danger : theme.status.warning)}
        bg={toOpenTuiOpaqueColor(theme.surfaces.prompt)}
      >
        {line.text}
      </text>
    </box>
  );
}

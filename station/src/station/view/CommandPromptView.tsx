import { commandPromptForScreen } from "@station/dashboard-core/selectors";
import type { DashboardScreenView } from "@station/dashboard-core/state";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";

export function CommandPromptView({ screen }: { screen: DashboardScreenView }) {
  const theme = useStationTheme();
  const prompt = commandPromptForScreen(screen);
  if (prompt === undefined) {
    return null;
  }
  return (
    <box
      id="station-command-prompt"
      width="100%"
      minHeight={0}
      flexShrink={1}
      marginBottom={1}
      overflow="hidden"
      backgroundColor={toOpenTuiOpaqueColor(theme.surfaces.prompt)}
    >
      <text
        fg={toOpenTuiColor(
          prompt.tone === "danger" ? theme.status.danger : theme.status.warning,
        )}
        bg={toOpenTuiOpaqueColor(theme.surfaces.prompt)}
        wrapMode="word"
      >
        {prompt.text}
      </text>
    </box>
  );
}

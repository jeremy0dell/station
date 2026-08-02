// Render layer: one-line yellow/red command prompt (search, collapse, confirm,
// rename modes). Prompt copy and color come from the shared content module.
import { commandPromptLineForScreen, type TuiScreen } from "@station/dashboard-core";
import { toOpenTuiColor, toOpenTuiOpaqueColor, useStationTheme } from "../../theme/index.js";

export function CommandPromptView({ screen }: { screen: TuiScreen }) {
  const theme = useStationTheme();
  const line = commandPromptLineForScreen(screen);
  if (line === undefined) {
    return null;
  }
  return (
    <box position="absolute" left={0} right={0} bottom={3} zIndex={5} flexDirection="column">
      <text
        fg={toOpenTuiColor(
          line.color === "red" ? theme.status.danger : theme.status.warning,
        )}
        bg={toOpenTuiOpaqueColor(theme.surfaces.prompt)}
      >
        {line.text}
      </text>
    </box>
  );
}

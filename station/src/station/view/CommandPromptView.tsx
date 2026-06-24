// Render layer: one-line yellow/red command prompt (search, collapse, confirm,
// rename modes). Prompt copy and color come from the shared content module.
import { commandPromptLineForScreen, type TuiScreen } from "@station/dashboard-core";
import { STATION_COLORS } from "./theme.js";

export function CommandPromptView({ screen }: { screen: TuiScreen }) {
  const line = commandPromptLineForScreen(screen);
  if (line === undefined) {
    return null;
  }
  return (
    <box position="absolute" left={0} right={0} bottom={3} zIndex={5} flexDirection="column">
      <text fg={line.color === "red" ? STATION_COLORS.red : STATION_COLORS.yellow} bg={STATION_COLORS.background}>
        {line.text}
      </text>
    </box>
  );
}

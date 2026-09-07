import { join } from "node:path";
import { runManagedFastPopup } from "@station/tmux/popup-fast";
import { buildPopupRendererCommand } from "./popupRendererCommand.js";

/**
 * COMPOSITION ROOT
 *
 * Supplies the current renderer command to the popup adapter before loading the CLI fallback.
 */
export async function runTmuxPopupMain(
  argv: readonly string[],
  installedRoot: string,
  runCli: (argv: readonly string[]) => void | Promise<void>,
): Promise<void> {
  if (argv[0] === "__managed-popup") {
    await runManagedFastPopup(argv.slice(1), installedRoot, (configPath) =>
      buildPopupRendererCommand([join(installedRoot, "stn")], configPath),
    );
    return;
  }
  await runCli(argv[0] === "popup" ? argv : ["popup", ...argv]);
}

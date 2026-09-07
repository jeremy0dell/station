import { runManagedFastPopup } from "@station/tmux/popup-fast";

/**
 * COMPOSITION ROOT
 *
 * Chooses the current-build popup fast path before loading the full CLI fallback.
 */
export async function runTmuxPopupMain(
  argv: readonly string[],
  installedRoot: string,
  runCli: (argv: readonly string[]) => void | Promise<void>,
): Promise<void> {
  if (argv[0] === "__managed-popup") {
    await runManagedFastPopup(argv.slice(1), installedRoot);
    return;
  }
  await runCli(argv[0] === "popup" ? argv : ["popup", ...argv]);
}

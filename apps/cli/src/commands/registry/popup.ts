import { emptyConfig } from "@station/config";
import { createPopupLauncher } from "../../popupComposition.js";
import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type {
  CliCommandConfigErrorContext,
  CliCommandNode,
  CliCommandRunContext,
} from "../cliCommand/types.js";
import { isConfigError } from "../configDiagnostics.js";
import { type PopupCommandOptions, runPopupCommand } from "../popup.js";

export const popupCliCommand: CliCommandNode = {
  name: "popup",
  description: "Open the terminal popup dashboard.",
  requiresConfig: true,
  run: runPopupCliCommand,
  handleConfigError: handlePopupConfigError,
  usage: ["stn popup [--persistent]"],
  options: [
    {
      name: "--persistent",
      description: "Keep the popup lifecycle session available for reuse.",
    },
  ],
  examples: ["stn popup", "stn popup --persistent"],
};

async function handlePopupConfigError(error: unknown, context: CliCommandConfigErrorContext) {
  if (
    !isConfigError(error) ||
    error.code !== "CONFIG_FILE_NOT_FOUND" ||
    context.configPath !== undefined
  ) {
    return undefined;
  }
  // Keep the resolved path absent so the nested TUI does not receive --config for a missing file.
  return runPopupCliCommand({ ...context, config: emptyConfig() }, true);
}

async function runPopupCliCommand(context: CliCommandRunContext, firstRun = false) {
  const popupEnv = context.options.popupDeps?.env ?? context.options.env;
  const popupOptions: PopupCommandOptions = loadedCommandOptions(context);
  const composition: Parameters<typeof createPopupLauncher>[0] = {
    ...popupOptions,
    cliEntryPath: context.cliEntryPath,
    firstRun,
  };
  if (popupEnv !== undefined) composition.env = popupEnv;
  if (context.options.installedRoot !== undefined)
    composition.installedRoot = context.options.installedRoot;
  const popupDeps = {
    ...context.options.popupDeps,
    popup: context.options.popupDeps?.popup ?? createPopupLauncher(composition),
  };
  if (context.options.observerDeps !== undefined) popupDeps.observer = context.options.observerDeps;
  const result = await runPopupCommand(context.args, popupOptions, popupDeps);
  return { code: "code" in result ? result.code : 0, output: result };
}
